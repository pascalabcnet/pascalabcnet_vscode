[CmdletBinding()]
param(
    [string]$PascalABCSourcePath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repositoryRoot = [System.IO.Path]::GetFullPath(
    (Join-Path $PSScriptRoot '..')
)
$usesPinnedPascalABCSources = [string]::IsNullOrWhiteSpace(
    $PascalABCSourcePath
)
if ($usesPinnedPascalABCSources) {
    $PascalABCSourcePath = Join-Path $repositoryRoot `
        'externals\pascalabcnet-tooling\pascalabcnet'
}
$PascalABCSourcePath = [System.IO.Path]::GetFullPath($PascalABCSourcePath)

if ($usesPinnedPascalABCSources -and
    -not (Test-Path -LiteralPath `
        (Join-Path $PascalABCSourcePath 'PascalABCNET.sln') `
        -PathType Leaf)) {
    Write-Host '=== Initializing compiler submodules ==='
    Push-Location $repositoryRoot
    try {
        & git submodule update --init --recursive
        if ($LASTEXITCODE -ne 0) {
            throw "Git submodule initialization failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

$pascalABCRuntimeRoot = Join-Path $PascalABCSourcePath 'bin'
$modernPascalABCRuntimeRoot = Join-Path $PascalABCSourcePath 'bin-net10'
$compilerHostRoot = Join-Path $repositoryRoot 'compiler-host'
$controllerProjectPath = Join-Path $compilerHostRoot `
    'Controller\PABCCompilerController.csproj'
$workerProjectPath = Join-Path $compilerHostRoot `
    'Worker\ZMQServerPas.csproj'
$dependencyRoot = Join-Path $compilerHostRoot 'dependencies\netmq'
$buildRoot = Join-Path $repositoryRoot '.build'
$hostBuildRoot = Join-Path $buildRoot 'compiler-host'
$nextBinRoot = Join-Path $buildRoot 'bin-next'
$backupBinRoot = Join-Path $buildRoot 'bin-backup'
$outputBinRoot = Join-Path $repositoryRoot 'bin'
$compilerPath = Join-Path $pascalABCRuntimeRoot 'pabcnetcclear.exe'
$standardModulesCompilerPath = Join-Path $pascalABCRuntimeRoot 'pabcnetc.exe'
$modernCompilerPath = Join-Path $modernPascalABCRuntimeRoot `
    'pabcnetcclear.exe'

$excludedStandardModules = @(
    'ABCHouse',
    'ABCSprites',
    'Arrays',
    'BBCMicrobit',
    'BlockFileOfT',
    'ClientServer',
    'Collections',
    'Core',
    'Events',
    'MPI',
    'Oberon00System',
    'OpenCL',
    'OpenCLABC',
    'OpenGL',
    'OpenGLABC',
    'PointRect',
    'VCL'
)

$compilerCoreDlls = @(
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
    'TreeConverter.dll'
)

$legacyCompilerDlls = @($compilerCoreDlls) + @('System.ValueTuple.dll')
$modernCompilerDlls = @($compilerCoreDlls)

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

    $modernRuntimeProcesses = @(Get-CimInstance Win32_Process `
        -Filter "Name = 'dotnet.exe'" `
        -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine.IndexOf(
                $binPrefix,
                [System.StringComparison]::OrdinalIgnoreCase
            ) -ge 0
        })

    if ($runtimeProcesses.Count -eq 0 -and
        $modernRuntimeProcesses.Count -eq 0) {
        return
    }

    $processList = @(
        $runtimeProcesses |
            ForEach-Object { "$($_.ProcessName).exe (PID $($_.Id))" }
        $modernRuntimeProcesses |
            ForEach-Object { "dotnet.exe (PID $($_.ProcessId))" }
    )

    throw @"
The generated bin directory is currently in use by:
  $($processList -join "`n  ")

In VS Code run "PascalABC.NET: Restart Compiler" without compiling again,
or close the Extension Development Host, and then rerun this script.
"@
}

function Copy-PascalLibraryArtifacts {
    param(
        [string]$SourceRoot,
        [string]$DestinationRoot
    )

    Assert-DirectoryExists $SourceRoot
    New-Item -ItemType Directory -Path $DestinationRoot | Out-Null

    $sourcePrefix = [System.IO.Path]::GetFullPath($SourceRoot).TrimEnd('\') + '\'
    $sourceFiles = @(Get-ChildItem -LiteralPath $SourceRoot -Recurse -File |
        Where-Object {
            $_.Extension -in @('.pas', '.pcu') -and
            $_.BaseName -notin $excludedStandardModules
        })

    if ($sourceFiles.Count -eq 0) {
        throw "No Pascal library artifacts were found in: $SourceRoot"
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

    $pasCount = @($sourceFiles | Where-Object Extension -ieq '.pas').Count
    $pcuCount = @($sourceFiles | Where-Object Extension -ieq '.pcu').Count
    if ($pcuCount -eq 0) {
        throw "No compiled Pascal units were found in: $SourceRoot"
    }

    Write-Host "Copied $pasCount Pascal sources and $pcuCount compiled units."
}

function Copy-LanguageResources {
    param([string]$SourceRoot, [string]$DestinationRoot)

    New-Item -ItemType Directory -Path $DestinationRoot | Out-Null
    foreach ($languageName in @('Eng', 'Rus')) {
        $sourceLanguageRoot = Join-Path $SourceRoot $languageName
        Assert-DirectoryExists $sourceLanguageRoot
        Copy-Item -LiteralPath $sourceLanguageRoot `
            -Destination $DestinationRoot -Recurse
    }
}

function Copy-HostOutput {
    param(
        [string]$SourceRoot,
        [string]$DestinationRoot,
        [string[]]$Suffixes,
        [switch]$PreserveExisting
    )

    $sourcePrefix = [System.IO.Path]::GetFullPath($SourceRoot).TrimEnd('\') + '\'
    foreach ($sourceFile in Get-ChildItem -LiteralPath $SourceRoot -Recurse -File) {
        $matched = $false
        foreach ($suffix in $Suffixes) {
            if ($sourceFile.Name.EndsWith(
                $suffix,
                [System.StringComparison]::OrdinalIgnoreCase
            )) {
                $matched = $true
                break
            }
        }
        if (-not $matched -or $sourceFile.Extension -ieq '.pdb') {
            continue
        }

        $relativePath = $sourceFile.FullName.Substring($sourcePrefix.Length)
        $targetPath = Join-Path $DestinationRoot $relativePath
        if ($PreserveExisting -and
            (Test-Path -LiteralPath $targetPath -PathType Leaf)) {
            continue
        }

        $targetDirectory = Split-Path -Parent $targetPath
        New-Item -ItemType Directory -Path $targetDirectory -Force | Out-Null
        Copy-Item -LiteralPath $sourceFile.FullName -Destination $targetPath -Force
    }
}

function Invoke-PascalABCBuild {
    Write-Host 'Building PascalABC.NET compiler from the pinned submodule commit...'
    Push-Location $PascalABCSourcePath
    try {
        & dotnet build -c Release --no-incremental --disable-build-servers `
            -m:1 -p:BuildInParallel=false --nologo -v:minimal `
            PascalABCNET.sln -p:PABCNET_LEGACY_ONLY=true
        if ($LASTEXITCODE -ne 0) {
            throw "PascalABC.NET build failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-StandardModulesBuild {
    $generatorRoot = Join-Path $PascalABCSourcePath 'ReleaseGenerators'
    $generatorSource = Join-Path $generatorRoot 'RebuildStandartModules.pas'
    $libraryRoot = Join-Path $pascalABCRuntimeRoot 'Lib'
    Assert-FileExists $standardModulesCompilerPath
    Assert-FileExists $compilerPath
    Assert-FileExists $generatorSource

    Write-Host 'Rebuilding PascalABC.NET standard modules...'
    Push-Location $generatorRoot
    try {
        if ([Console]::IsOutputRedirected) {
            Get-ChildItem -LiteralPath $libraryRoot -Recurse -File -Filter '*.pcu' |
                Remove-Item -Force
            & $compilerPath 'RebuildStandartModules.pas'
        }
        else {
            & $standardModulesCompilerPath 'RebuildStandartModules.pas' '/rebuild'
        }
        if ($LASTEXITCODE -ne 0) {
            throw "Standard module build failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }
}

function Invoke-ModernPascalABCBuild {
    $solutionPath = Join-Path $PascalABCSourcePath 'pabcnetc.sln'
    $generatorRoot = Join-Path $PascalABCSourcePath 'ReleaseGenerators'
    $generatorName = 'RebuildStandartModulesNet10'
    $generatorSource = Join-Path $generatorRoot ($generatorName + '.pas')
    $libraryRoot = Join-Path $modernPascalABCRuntimeRoot 'Lib'

    Assert-FileExists $solutionPath
    Assert-FileExists $generatorSource

    Write-Host 'Building PascalABC.NET compiler for .NET 10...'
    & dotnet build $solutionPath `
        -c Release `
        -p:TargetFramework=net10.0 `
        -p:BuildInParallel=false `
        --disable-build-servers `
        -m:1 `
        --nologo `
        -v:minimal
    if ($LASTEXITCODE -ne 0) {
        throw "PascalABC.NET net10 build failed with exit code $LASTEXITCODE."
    }

    Assert-FileExists $modernCompilerPath
    Assert-DirectoryExists $libraryRoot

    Write-Host 'Rebuilding PascalABC.NET standard modules for .NET 10...'
    Get-ChildItem -LiteralPath $libraryRoot -Recurse -File -Filter '*.pcu' |
        Remove-Item -Force

    Push-Location $generatorRoot
    try {
        & $modernCompilerPath ($generatorName + '.pas')
        if ($LASTEXITCODE -ne 0) {
            throw "Modern standard module build failed with exit code $LASTEXITCODE."
        }
    }
    finally {
        Pop-Location
    }

    $modernUnits = @(Get-ChildItem -LiteralPath $libraryRoot `
        -Recurse -File -Filter '*.pcu')
    if ($modernUnits.Count -eq 0) {
        throw 'No .NET 10 compiled Pascal units were created.'
    }

    foreach ($extension in @('.exe', '.exe.config', '.dll', '.pdb',
        '.deps.json', '.runtimeconfig.json')) {
        $generatedPath = Join-Path $generatorRoot ($generatorName + $extension)
        if (Test-Path -LiteralPath $generatedPath) {
            Remove-Item -LiteralPath $generatedPath -Force
        }
    }
}

function Invoke-HostBuild {
    param(
        [string]$ProjectPath,
        [string]$TargetFramework,
        [string]$OutputRoot,
        [string]$AssemblyName
    )

    Write-Host "Compiling $AssemblyName for $TargetFramework..."
    & dotnet build $ProjectPath `
        -c Release `
        -f $TargetFramework `
        --disable-build-servers `
        -m:1 `
        -p:BuildInParallel=false `
        -p:SatelliteResourceLanguages=ru `
        --nologo `
        --output $OutputRoot

    if ($LASTEXITCODE -ne 0) {
        throw "$AssemblyName build failed with exit code $LASTEXITCODE."
    }

    if ($TargetFramework -eq 'net472') {
        Assert-FileExists (Join-Path $OutputRoot ($AssemblyName + '.exe'))
        Assert-FileExists (Join-Path $OutputRoot ($AssemblyName + '.exe.config'))
    }
    else {
        Assert-FileExists (Join-Path $OutputRoot ($AssemblyName + '.dll'))
        Assert-FileExists (Join-Path $OutputRoot ($AssemblyName + '.deps.json'))
        Assert-FileExists `
            (Join-Path $OutputRoot ($AssemblyName + '.runtimeconfig.json'))
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

function Write-ControllerRequest {
    param(
        [System.Diagnostics.Process]$Process,
        [string]$Request
    )

    $requestBytes = [System.Text.Encoding]::UTF8.GetBytes($Request + "`n")
    $Process.StandardInput.BaseStream.Write(
        $requestBytes,
        0,
        $requestBytes.Length
    )
    $Process.StandardInput.BaseStream.Flush()
}

function Test-CompilerRuntime {
    param(
        [string]$RuntimeRoot,
        [ValidateSet('net-framework', 'net10')]
        [string]$Target
    )

    Write-Host "Running $Target controller smoke test..."
    $sampleDirectory = Join-Path $buildRoot 'папка с пробелами'
    New-Item -ItemType Directory -Path $sampleDirectory -Force | Out-Null
    $samplePath = Join-Path $sampleDirectory 'Часы.pas'
    @(
        'begin'
        "  Println('runtime smoke test');"
        'end.'
    ) | Set-Content -LiteralPath $samplePath -Encoding UTF8

    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    if ($Target -eq 'net-framework') {
        $startInfo.FileName = Join-Path $RuntimeRoot 'PABCCompilerController.exe'
    }
    else {
        $startInfo.FileName = 'dotnet'
        $controllerPath = Join-Path $RuntimeRoot 'PABCCompilerController.dll'
        $startInfo.Arguments = '"' + $controllerPath + '"'
    }
    $startInfo.WorkingDirectory = $RuntimeRoot
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardInput = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true
    $startInfo.StandardOutputEncoding = [System.Text.Encoding]::UTF8
    $startInfo.StandardErrorEncoding = [System.Text.Encoding]::UTF8

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = $startInfo

    try {
        if (-not $process.Start()) {
            throw 'Could not start PABCCompilerController.'
        }

        $pingRequest = @{ id = 1; command = 'ping' } | ConvertTo-Json -Compress
        Write-ControllerRequest $process $pingRequest
        $pingResponse = Read-ControllerResponse $process

        if (-not $pingResponse.success -or $pingResponse.result -ne 'PONG') {
            throw "Controller ping failed: $($pingResponse | ConvertTo-Json -Compress)"
        }

        $compileRequest = @{
            id = 2
            command = 'compile'
            fileName = $samplePath
        } | ConvertTo-Json -Compress
        Write-ControllerRequest $process $compileRequest
        $compileResponse = Read-ControllerResponse $process 40

        if (-not $compileResponse.success) {
            throw "Controller compile test failed: $($compileResponse | ConvertTo-Json -Compress)"
        }
        if ($compileResponse.fileName -cne $samplePath) {
            throw "Controller changed the Unicode source path: $($compileResponse.fileName)"
        }

        $outputPath = [System.IO.Path]::ChangeExtension($samplePath, '.exe')
        Assert-FileExists $outputPath
        if ($Target -eq 'net10') {
            $programOutput = & dotnet $outputPath
            if ($LASTEXITCODE -ne 0 -or
                $programOutput -notcontains 'runtime smoke test') {
                throw 'The .NET 10 compiled program did not run successfully.'
            }
        }

        $shutdownRequest = @{ id = 3; command = 'shutdown' } |
            ConvertTo-Json -Compress
        Write-ControllerRequest $process $shutdownRequest
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
        Remove-BuildDirectory $sampleDirectory
    }

    Write-Host "$Target controller smoke test passed."
}

function Assert-RuntimeLayout {
    param(
        [string]$RuntimeRoot,
        [ValidateSet('net-framework', 'net10')]
        [string]$Target
    )

    if ($Target -eq 'net-framework') {
        $requiredRootFiles = @($legacyCompilerDlls) + @($hostDependencies) + @(
            'PABCCompilerController.exe'
            'PABCCompilerController.exe.config'
            'ZMQServerPas.exe'
            'ZMQServerPas.exe.config'
        )
        $allowedRootExtensions = @('.dll', '.exe', '.config')
        $expectedExecutables = @(
            'PABCCompilerController.exe',
            'ZMQServerPas.exe'
        )
    }
    else {
        $requiredRootFiles = @($modernCompilerDlls) + @(
            'PABCCompilerController.dll'
            'PABCCompilerController.deps.json'
            'PABCCompilerController.runtimeconfig.json'
            'ZMQServerPas.dll'
            'ZMQServerPas.deps.json'
            'ZMQServerPas.runtimeconfig.json'
        )
        $allowedRootExtensions = @('.dll', '.json')
        $expectedExecutables = @()
    }

    foreach ($fileName in $requiredRootFiles) {
        Assert-FileExists (Join-Path $RuntimeRoot $fileName)
    }

    $unexpectedRootFiles = @(Get-ChildItem -LiteralPath $RuntimeRoot -File |
        Where-Object { $_.Extension -notin $allowedRootExtensions })
    if ($unexpectedRootFiles.Count -ne 0) {
        throw "Unexpected files in bin root: $($unexpectedRootFiles.Name -join ', ')"
    }

    $rootExecutables = @(Get-ChildItem -LiteralPath $RuntimeRoot -File -Filter '*.exe' |
        Select-Object -ExpandProperty Name | Sort-Object)
    if (($rootExecutables -join '|') -ne ($expectedExecutables -join '|')) {
        throw "Unexpected executable set: $($rootExecutables -join ', ')"
    }

    $libraryRoot = Join-Path $RuntimeRoot 'Lib'
    Assert-DirectoryExists $libraryRoot
    $unexpectedLibraryFiles = @(Get-ChildItem -LiteralPath $libraryRoot -Recurse -File |
        Where-Object {
            $_.Extension -notin @('.pas', '.pcu') -and
            $_.Name -ine 'turtle.png'
        })
    if ($unexpectedLibraryFiles.Count -ne 0) {
        throw "Unexpected files in Lib: $($unexpectedLibraryFiles.FullName -join ', ')"
    }
    Assert-FileExists (Join-Path $libraryRoot 'turtle.png')

    $compiledUnits = @(Get-ChildItem -LiteralPath $libraryRoot -Recurse -File `
        -Filter '*.pcu')
    if ($compiledUnits.Count -eq 0) {
        throw 'No compiled Pascal units were included in the runtime.'
    }
    foreach ($excludedModule in $excludedStandardModules) {
        foreach ($extension in @('.pas', '.pcu')) {
            $excludedPath = Join-Path $libraryRoot ($excludedModule + $extension)
            if (Test-Path -LiteralPath $excludedPath) {
                throw "Excluded standard module was included: $excludedPath"
            }
        }
    }

    $languageRoot = Join-Path $RuntimeRoot 'Lng'
    Assert-DirectoryExists $languageRoot
    $languageNames = @(Get-ChildItem -LiteralPath $languageRoot -Directory |
        Select-Object -ExpandProperty Name | Sort-Object)
    if (($languageNames -join '|') -ne 'Eng|Rus') {
        throw "Unexpected language directories: $($languageNames -join ', ')"
    }
}

Write-Host "PascalABC.NET source: $PascalABCSourcePath"
Assert-DirectoryExists $PascalABCSourcePath
Assert-FileExists (Join-Path $PascalABCSourcePath 'PascalABCNET.sln')
Assert-FileExists $controllerProjectPath
Assert-FileExists (Join-Path $compilerHostRoot 'Controller\Program.cs')
Assert-FileExists $workerProjectPath
Assert-FileExists (Join-Path $compilerHostRoot 'Worker\Program.cs')
Assert-DirectoryExists (Join-Path $pascalABCRuntimeRoot 'Lib')
Assert-DirectoryExists (Join-Path $pascalABCRuntimeRoot 'Lng\Eng')
Assert-DirectoryExists (Join-Path $pascalABCRuntimeRoot 'Lng\Rus')
foreach ($dependencyName in $hostDependencies) {
    Assert-FileExists (Join-Path $dependencyRoot $dependencyName)
}

Assert-OutputRuntimeNotInUse
Invoke-PascalABCBuild
Invoke-StandardModulesBuild
Invoke-ModernPascalABCBuild

Assert-FileExists $compilerPath
foreach ($dllName in $legacyCompilerDlls) {
    Assert-FileExists (Join-Path $pascalABCRuntimeRoot $dllName)
}
foreach ($dllName in $modernCompilerDlls) {
    Assert-FileExists (Join-Path $modernPascalABCRuntimeRoot $dllName)
}

New-Item -ItemType Directory -Path $buildRoot -Force | Out-Null
Remove-BuildDirectory $hostBuildRoot
Remove-BuildDirectory $nextBinRoot
Remove-BuildDirectory $backupBinRoot
New-Item -ItemType Directory -Path $hostBuildRoot | Out-Null
New-Item -ItemType Directory -Path $nextBinRoot | Out-Null

$legacyRuntimeRoot = Join-Path $nextBinRoot 'net-framework'
$modernRuntimeRoot = Join-Path $nextBinRoot 'net10'
New-Item -ItemType Directory -Path $legacyRuntimeRoot | Out-Null
New-Item -ItemType Directory -Path $modernRuntimeRoot | Out-Null

$legacyControllerBuildRoot = Join-Path $hostBuildRoot 'Controller-net472'
$legacyWorkerBuildRoot = Join-Path $hostBuildRoot 'Worker-net472'
$modernControllerBuildRoot = Join-Path $hostBuildRoot 'Controller-net10'
$modernWorkerBuildRoot = Join-Path $hostBuildRoot 'Worker-net10'

Invoke-HostBuild $controllerProjectPath 'net472' `
    $legacyControllerBuildRoot 'PABCCompilerController'
Invoke-HostBuild $workerProjectPath 'net472' `
    $legacyWorkerBuildRoot 'ZMQServerPas'
Invoke-HostBuild $controllerProjectPath 'net10.0' `
    $modernControllerBuildRoot 'PABCCompilerController'
Invoke-HostBuild $workerProjectPath 'net10.0' `
    $modernWorkerBuildRoot 'ZMQServerPas'

foreach ($dllName in $legacyCompilerDlls) {
    Copy-RequiredFile (Join-Path $pascalABCRuntimeRoot $dllName) `
        $legacyRuntimeRoot
}
foreach ($dependencyName in $hostDependencies) {
    Copy-RequiredFile (Join-Path $dependencyRoot $dependencyName) `
        $legacyRuntimeRoot
}

foreach ($dllFile in Get-ChildItem -LiteralPath $modernPascalABCRuntimeRoot `
    -File -Filter '*.dll') {
    Copy-Item -LiteralPath $dllFile.FullName -Destination $modernRuntimeRoot
}

Copy-HostOutput $legacyControllerBuildRoot $legacyRuntimeRoot `
    @('.exe', '.exe.config')
Copy-HostOutput $legacyWorkerBuildRoot $legacyRuntimeRoot `
    @('.exe', '.exe.config')
Copy-HostOutput $modernControllerBuildRoot $modernRuntimeRoot `
    @('.dll', '.deps.json', '.runtimeconfig.json') -PreserveExisting
Copy-HostOutput $modernWorkerBuildRoot $modernRuntimeRoot `
    @('.dll', '.deps.json', '.runtimeconfig.json') -PreserveExisting

$legacyLibRoot = Join-Path $legacyRuntimeRoot 'Lib'
Copy-PascalLibraryArtifacts (Join-Path $pascalABCRuntimeRoot 'Lib') `
    $legacyLibRoot
Copy-RequiredFile (Join-Path $pascalABCRuntimeRoot 'Lib\turtle.png') `
    $legacyLibRoot
Copy-LanguageResources (Join-Path $pascalABCRuntimeRoot 'Lng') `
    (Join-Path $legacyRuntimeRoot 'Lng')

$modernLibRoot = Join-Path $modernRuntimeRoot 'Lib'
Copy-PascalLibraryArtifacts (Join-Path $modernPascalABCRuntimeRoot 'Lib') `
    $modernLibRoot
Copy-RequiredFile (Join-Path $modernPascalABCRuntimeRoot 'Lib\turtle.png') `
    $modernLibRoot
Copy-LanguageResources (Join-Path $modernPascalABCRuntimeRoot 'Lng') `
    (Join-Path $modernRuntimeRoot 'Lng')

Assert-RuntimeLayout $legacyRuntimeRoot 'net-framework'
Assert-RuntimeLayout $modernRuntimeRoot 'net10'
Test-CompilerRuntime $legacyRuntimeRoot 'net-framework'
Test-CompilerRuntime $modernRuntimeRoot 'net10'
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
