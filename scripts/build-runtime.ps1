[CmdletBinding()]
param(
    [string]$PascalABCPath = "${env:ProgramFiles(x86)}\PascalABC.NET"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [System.IO.Path]::GetFullPath(
    (Join-Path $PSScriptRoot '..')
)
$compilerHostRoot = Join-Path $repositoryRoot 'compiler-host'
$dependencyRoot = Join-Path $compilerHostRoot 'dependencies\netmq'
$buildRoot = Join-Path $repositoryRoot '.build'
$hostBuildRoot = Join-Path $buildRoot 'compiler-host'
$nextBinRoot = Join-Path $buildRoot 'bin-next'
$backupBinRoot = Join-Path $buildRoot 'bin-backup'
$outputBinRoot = Join-Path $repositoryRoot 'bin'
$compilerPath = Join-Path $PascalABCPath 'pabcnetcclear.exe'

$compilerDlls = @(
    'Compiler.dll',
    'CompilerTools.dll',
    'Errors.dll',
    'LambdaAnySynToSemConverter.dll',
    'LanguageIntegrator.dll',
    'Localization.dll',
    'NETGenerator.dll',
    'OptimizerConversion.dll',
    'PABCCoreUtils.dll',
    'ParserTools.dll',
    'PascalABCLanguageInfo.dll',
    'PascalABCParser.dll',
    'SemanticTree.dll',
    'StringConstants.dll',
    'SyntaxTree.dll',
    'SyntaxTreeConverters.dll',
    'SyntaxVisitors.dll',
    'System.ValueTuple.dll',
    'TreeConverter.dll',
    'YieldHelpers.dll'
)

$hostDependencies = @(
    'AsyncIO.dll',
    'NaCl.dll',
    'NetMQ.dll',
    'System.Buffers.dll',
    'System.Memory.dll',
    'System.Numerics.Vectors.dll',
    'System.Runtime.CompilerServices.Unsafe.dll',
    'System.Threading.Tasks.Extensions.dll'
)

$hostSources = @(
    'CompileRunHelper.pas',
    'ZMQServerPas.pas',
    'PABCCompilerController.pas'
)

function Assert-FileExists {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required file was not found: $Path"
    }
}

function Assert-DirectoryExists {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
        throw "Required directory was not found: $Path"
    }
}

function Remove-BuildDirectory {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return
    }

    $resolvedBuildRoot = [System.IO.Path]::GetFullPath($buildRoot).TrimEnd('\')
    $resolvedPath = [System.IO.Path]::GetFullPath($Path)
    $requiredPrefix = $resolvedBuildRoot + '\'

    if (-not $resolvedPath.StartsWith(
        $requiredPrefix,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
        throw "Refusing to remove a directory outside .build: $resolvedPath"
    }

    Remove-Item -LiteralPath $resolvedPath -Recurse -Force
}

function Copy-RequiredFile {
    param(
        [string]$Source,
        [string]$DestinationDirectory
    )

    Assert-FileExists $Source
    Copy-Item -LiteralPath $Source -Destination $DestinationDirectory
}

function Assert-OutputRuntimeNotInUse {
    if (-not (Test-Path -LiteralPath $outputBinRoot -PathType Container)) {
        return
    }

    $binPrefix = [System.IO.Path]::GetFullPath($outputBinRoot).TrimEnd('\') + '\'
    $runtimeProcesses = @(Get-Process `
        -Name 'PABCCompilerController', 'ZMQServerPas' `
        -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Path -and
            $_.Path.StartsWith(
                $binPrefix,
                [System.StringComparison]::OrdinalIgnoreCase
            )
        })

    if ($runtimeProcesses.Count -eq 0) {
        return
    }

    $processList = $runtimeProcesses |
        ForEach-Object { "$($_.ProcessName).exe (PID $($_.Id))" }

    throw @"
The generated bin directory is currently in use by:
  $($processList -join "`n  ")

In VS Code run "PascalABC.NET: Restart Compiler" without compiling again,
or close the Extension Development Host, and then rerun this script.
"@
}

function Copy-PascalLibrarySources {
    param(
        [string]$SourceRoot,
        [string]$DestinationRoot
    )

    Assert-DirectoryExists $SourceRoot
    New-Item -ItemType Directory -Path $DestinationRoot | Out-Null

    $sourcePrefix = [System.IO.Path]::GetFullPath($SourceRoot).TrimEnd('\') + '\'
    $sourceFiles = @(Get-ChildItem -LiteralPath $SourceRoot -Recurse -File |
        Where-Object { $_.Extension -ieq '.pas' })

    if ($sourceFiles.Count -eq 0) {
        throw "No Pascal library sources were found in: $SourceRoot"
    }

    foreach ($sourceFile in $sourceFiles) {
        $relativePath = $sourceFile.FullName.Substring($sourcePrefix.Length)
        $targetPath = Join-Path $DestinationRoot $relativePath
        $targetDirectory = Split-Path -Parent $targetPath

        if (-not (Test-Path -LiteralPath $targetDirectory)) {
            New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
        }

        Copy-Item -LiteralPath $sourceFile.FullName -Destination $targetPath
    }

    Write-Host "Copied $($sourceFiles.Count) Pascal library sources."
}

function Invoke-PascalCompilation {
    param([string]$SourceName)

    Write-Host "Compiling $SourceName..."
    $compilerOutput = & $compilerPath $SourceName 2>&1

    if ($LASTEXITCODE -ne 0) {
        throw "PascalABC.NET failed to compile ${SourceName}:`n$compilerOutput"
    }

    if ($compilerOutput) {
        Write-Host ($compilerOutput -join [Environment]::NewLine)
    }
}

function Read-ControllerResponse {
    param(
        [System.Diagnostics.Process]$Process,
        [int]$TimeoutSeconds = 20
    )

    $readTask = $Process.StandardOutput.ReadLineAsync()

    if (-not $readTask.Wait([TimeSpan]::FromSeconds($TimeoutSeconds))) {
        throw "PABCCompilerController did not respond within $TimeoutSeconds seconds."
    }

    if ($null -eq $readTask.Result) {
        $errorText = $Process.StandardError.ReadToEnd()
        throw "PABCCompilerController closed stdout unexpectedly.`n$errorText"
    }

    return $readTask.Result | ConvertFrom-Json
}

function Test-CompilerRuntime {
    param([string]$RuntimeRoot)

    Write-Host 'Running controller smoke test...'
    $samplePath = Join-Path $buildRoot 'runtime-smoke-test.pas'
    @(
        'begin'
        "  Println('runtime smoke test');"
        'end.'
    ) | Set-Content -LiteralPath $samplePath -Encoding UTF8

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = Join-Path $RuntimeRoot 'PABCCompilerController.exe'
    $startInfo.WorkingDirectory = $RuntimeRoot
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo

    try {
        if (-not $process.Start()) {
            throw 'Could not start PABCCompilerController.'
        }

        $pingRequest = @{ id = 1; command = 'ping' } | ConvertTo-Json -Compress
        $process.StandardInput.WriteLine($pingRequest)
        $process.StandardInput.Flush()
        $pingResponse = Read-ControllerResponse $process

        if (-not $pingResponse.success -or $pingResponse.result -ne 'PONG') {
            throw "Controller ping failed: $($pingResponse | ConvertTo-Json -Compress)"
        }

        $compileRequest = @{
            id = 2
            command = 'compile'
            fileName = $samplePath
        } | ConvertTo-Json -Compress
        $process.StandardInput.WriteLine($compileRequest)
        $process.StandardInput.Flush()
        $compileResponse = Read-ControllerResponse $process 40

        if (-not $compileResponse.success) {
            throw "Controller compile test failed: $($compileResponse | ConvertTo-Json -Compress)"
        }

        $shutdownRequest = @{ id = 3; command = 'shutdown' } |
            ConvertTo-Json -Compress
        $process.StandardInput.WriteLine($shutdownRequest)
        $process.StandardInput.Flush()
        $shutdownResponse = Read-ControllerResponse $process

        if (-not $shutdownResponse.success) {
            throw "Controller shutdown failed: $($shutdownResponse | ConvertTo-Json -Compress)"
        }

        if (-not $process.WaitForExit(10000)) {
            throw 'PABCCompilerController did not exit after shutdown.'
        }
    }
    finally {
        if (-not $process.HasExited) {
            $process.Kill()
            $process.WaitForExit()
        }

        $process.Dispose()
        Remove-Item -LiteralPath $samplePath -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath ([System.IO.Path]::ChangeExtension($samplePath, '.exe')) `
            -Force -ErrorAction SilentlyContinue
    }

    Write-Host 'Controller smoke test passed.'
}

function Assert-RuntimeLayout {
    param([string]$RuntimeRoot)

    $requiredRootFiles = @(
        $compilerDlls
        $hostDependencies
        'PABCCompilerController.exe'
        'ZMQServerPas.exe'
    )

    foreach ($fileName in $requiredRootFiles) {
        Assert-FileExists (Join-Path $RuntimeRoot $fileName)
    }

    $unexpectedRootFiles = @(Get-ChildItem -LiteralPath $RuntimeRoot -File |
        Where-Object { $_.Extension -notin @('.dll', '.exe') })
    if ($unexpectedRootFiles.Count -ne 0) {
        throw "Unexpected files in bin root: $($unexpectedRootFiles.Name -join ', ')"
    }

    $rootExecutables = @(Get-ChildItem -LiteralPath $RuntimeRoot -File -Filter '*.exe' |
        Select-Object -ExpandProperty Name | Sort-Object)
    $expectedExecutables = @('PABCCompilerController.exe', 'ZMQServerPas.exe')
    if (($rootExecutables -join '|') -ne ($expectedExecutables -join '|')) {
        throw "Unexpected executable set: $($rootExecutables -join ', ')"
    }

    $libraryRoot = Join-Path $RuntimeRoot 'Lib'
    Assert-DirectoryExists $libraryRoot
    $unexpectedLibraryFiles = @(Get-ChildItem -LiteralPath $libraryRoot -Recurse -File |
        Where-Object {
            $_.Extension -ine '.pas' -and $_.Name -ine 'turtle.png'
        })
    if ($unexpectedLibraryFiles.Count -ne 0) {
        throw "Unexpected files in Lib: $($unexpectedLibraryFiles.FullName -join ', ')"
    }
    Assert-FileExists (Join-Path $libraryRoot 'turtle.png')

    $languageRoot = Join-Path $RuntimeRoot 'Lng'
    Assert-DirectoryExists $languageRoot
    $languageNames = @(Get-ChildItem -LiteralPath $languageRoot -Directory |
        Select-Object -ExpandProperty Name | Sort-Object)
    if (($languageNames -join '|') -ne 'Eng|Rus') {
        throw "Unexpected language directories: $($languageNames -join ', ')"
    }
}

Write-Host "PascalABC.NET installation: $PascalABCPath"
Assert-DirectoryExists $PascalABCPath
Assert-FileExists $compilerPath
Assert-DirectoryExists (Join-Path $PascalABCPath 'LibSource')
Assert-DirectoryExists (Join-Path $PascalABCPath 'Lng\Eng')
Assert-DirectoryExists (Join-Path $PascalABCPath 'Lng\Rus')

foreach ($sourceName in $hostSources) {
    Assert-FileExists (Join-Path $compilerHostRoot $sourceName)
}
foreach ($dependencyName in $hostDependencies) {
    Assert-FileExists (Join-Path $dependencyRoot $dependencyName)
}
foreach ($dllName in $compilerDlls) {
    Assert-FileExists (Join-Path $PascalABCPath $dllName)
}

Assert-OutputRuntimeNotInUse

New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
Remove-BuildDirectory $hostBuildRoot
Remove-BuildDirectory $nextBinRoot
Remove-BuildDirectory $backupBinRoot
New-Item -ItemType Directory -Path $hostBuildRoot | Out-Null
New-Item -ItemType Directory -Path $nextBinRoot | Out-Null

foreach ($dllName in $compilerDlls) {
    Copy-RequiredFile (Join-Path $PascalABCPath $dllName) $nextBinRoot
}
foreach ($dependencyName in $hostDependencies) {
    Copy-RequiredFile (Join-Path $dependencyRoot $dependencyName) $nextBinRoot
}

$nextLibRoot = Join-Path $nextBinRoot 'Lib'
Copy-PascalLibrarySources (Join-Path $PascalABCPath 'LibSource') $nextLibRoot
Copy-RequiredFile (Join-Path $PascalABCPath 'Lib\turtle.png') $nextLibRoot

$nextLanguageRoot = Join-Path $nextBinRoot 'Lng'
New-Item -ItemType Directory -Path $nextLanguageRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $PascalABCPath 'Lng\Eng') `
    -Destination $nextLanguageRoot -Recurse
Copy-Item -LiteralPath (Join-Path $PascalABCPath 'Lng\Rus') `
    -Destination $nextLanguageRoot -Recurse

foreach ($sourceName in $hostSources) {
    Copy-RequiredFile (Join-Path $compilerHostRoot $sourceName) $hostBuildRoot
}
Get-ChildItem -LiteralPath $nextBinRoot -File -Filter '*.dll' |
    Copy-Item -Destination $hostBuildRoot

Push-Location $hostBuildRoot
try {
    foreach ($sourceName in $hostSources) {
        Invoke-PascalCompilation $sourceName
    }
}
finally {
    Pop-Location
}

Copy-RequiredFile (Join-Path $hostBuildRoot 'PABCCompilerController.exe') $nextBinRoot
Copy-RequiredFile (Join-Path $hostBuildRoot 'ZMQServerPas.exe') $nextBinRoot

Assert-RuntimeLayout $nextBinRoot
Test-CompilerRuntime $nextBinRoot
Assert-OutputRuntimeNotInUse

if (Test-Path -LiteralPath $outputBinRoot) {
    Move-Item -LiteralPath $outputBinRoot -Destination $backupBinRoot
}

try {
    Move-Item -LiteralPath $nextBinRoot -Destination $outputBinRoot
}
catch {
    if (Test-Path -LiteralPath $backupBinRoot) {
        Move-Item -LiteralPath $backupBinRoot -Destination $outputBinRoot
    }
    throw
}

Remove-BuildDirectory $backupBinRoot
Remove-BuildDirectory $hostBuildRoot

if ((Test-Path -LiteralPath $buildRoot) -and
    -not (Get-ChildItem -LiteralPath $buildRoot -Force | Select-Object -First 1)) {
    Remove-Item -LiteralPath $buildRoot -Force
}

Write-Host "Runtime prepared successfully: $outputBinRoot"
