# Multitarget PascalABC.NET for Visual Studio Code

Multitarget PascalABC.NET provides PascalABC.NET language support, IntelliSense, compilation, and execution in Visual Studio Code. It is developed and maintained by the PascalABC.NET Team.

## About PascalABC.NET

PascalABC.NET is a modern Pascal programming language that combines the simplicity and clarity of classic Pascal with contemporary language features and the capabilities of the Microsoft .NET platform.

It supports procedural, object-oriented, and functional programming styles, making it well suited for teaching modern programming—from a beginner's first programs to university-level courses. Its concise and readable syntax helps students focus on algorithms, problem solving, and software design.

PascalABC.NET is also a practical tool for console applications, educational and scientific projects, and general-purpose programming. It is free software distributed under the GNU LGPLv3 license.

## Extension Features

- PascalABC.NET syntax highlighting and language configuration
- snippets for common language constructs
- semantic completion, including member completion after `.`
- hover information and signature help for calls and overloads
- compilation diagnostics in the editor
- compile current file with `Ctrl+F9`
- compile and run with `F9`
- execution in an integrated terminal with console input support
- selectable .NET Framework 4.7.2 (Windows) and cross-platform .NET 10 compiler runtimes
- commands for restarting the compiler process and showing its output

## Compiler Targets

The name **Multitarget PascalABC.NET** reflects the two independent PascalABC.NET compiler runtimes included with the extension:

| Target | Best suited for | Program launch |
| --- | --- | --- |
| .NET Framework 4.7.2 | Windows; compatibility with the classic PascalABC.NET environment | runs the generated `.exe` directly |
| .NET 10 | Windows, Linux, and macOS; modern .NET applications and current platform capabilities | runs the generated `.exe` with `dotnet` |

Select the target from the **PascalABC.NET** item in the status bar or run **PascalABC.NET: Select Compiler Target** from the Command Palette. Each target has its own compiler assemblies and compatible precompiled standard units.

## Architecture and Local Tooling

This is a development-tool extension, not only a syntax-highlighting package. The VSIX contains the PascalABC.NET compiler and the local tooling binaries required for IntelliSense and compilation.

The TypeScript extension starts these components as child processes when needed:

- `PascalABCNet.LanguageServer.dll` runs through `dotnet` and provides semantic IntelliSense over the Language Server Protocol using stdio.
- `PABCCompilerController.exe` is used for the .NET Framework target; its .NET 10 counterpart is `PABCCompilerController.dll`, launched through `dotnet`. The controller accepts JSON Lines requests from the extension and manages compiler-worker lifetime.
- `PABCCompilerWorker.exe` or `PABCCompilerWorker.dll` is the compiler worker. It loads the selected PascalABC.NET compiler runtime and performs compilation outside the VS Code extension host.

Both compiler targets come from the main PascalABC.NET repository, without Tooling in the build chain. The .NET 10 compiler, controller, worker, language server and dependencies are imported as one prepared kit: manifest-listed files and standard PCUs are verified by SHA-256, including the final VSIX. Framework compiler, standard units and controller/worker are built directly from the supplied main checkout. Controller and worker communicate through redirected standard input/output using JSON Lines. Runtime components are bundled with the extension.

## Runtime Behavior

**Compile Current File** saves a modified document, starts the selected controller lazily, sends a compile request, and publishes the returned PascalABC.NET diagnostics in VS Code.

**Compile and Run** uses the same compilation path. After successful compilation it starts the generated program in the integrated terminal so that console input and output remain available. The program is run directly for .NET Framework or through `dotnet` for .NET 10; it is not executed by the language server or compiler worker.

Generated executables and their companion files are placed in a shared `output` directory in the extension's VS Code storage instead of beside the Pascal source. Programs still run with the source directory as their working directory, so relative paths such as `ReadAllText('input.txt')` continue to resolve next to the `.pas` file. Use **PascalABC.NET: Open Compilation Output Folder** to open this directory.

**Restart Compiler** stops the current controller and its worker, clears compiler diagnostics, and leaves the next compilation to start a fresh controller lazily. Closing VS Code also disposes the controller and language client.

## Getting Started

1. Create a file using **File → New File → PascalABC.NET File**, or open an existing `.pas` file.
2. If needed, select **.NET Framework 4.7.2** or **.NET 10** from the PascalABC.NET status bar item.
3. Press `F9` to compile and run it.
4. Use the integrated terminal for console input and program output.

Compiler errors are displayed directly in the editor. `Ctrl+F9` compiles the current file without running it.

## Platform Support

This preview supports Windows, Linux, and macOS. The compiler runtime required for ordinary PascalABC.NET programs is bundled with the extension, so a separate PascalABC.NET installation is not required for the basic compile-and-run workflow.

On Windows, both the classic .NET Framework 4.7.2 target and the modern .NET 10 target are available. On Linux and macOS, the extension automatically uses .NET 10 and does not offer the Windows-only .NET Framework target. The .NET 10 runtime must be installed on the computer; both the compiler and generated programs are launched through `dotnet`.

Some optional modules depend on components normally installed with the full PascalABC.NET distribution. For example, `Graph3D` expects HelixToolkit and `NUnitABC` expects NUnit.

## IntelliSense

Semantic language features are provided by the language server included in the unified [PascalABC.NET](https://github.com/pascalabcnet/pascalabcnet) .NET 10 kit. The extension starts it through `dotnet` as an independent process and communicates with it through the standard Language Server Protocol over stdio.

The language server owns document synchronization and PascalABC.NET semantic analysis, including global and member completion. Use **Go to Definition** (`F12`, or Ctrl+click) and **Go to Implementations** (`Ctrl+F12` on Windows/Linux) to navigate to Pascal source. CLR symbols without source open as read-only Pascal declarations generated from metadata, not decompiled method bodies. Navigation depends on the capabilities of the selected language server. The compiler controller remains an independent process and continues to handle explicit Compile and Run commands.

### NuGet packages (.NET 10)

Open a saved PascalABC.NET file and use the Command Palette:

- **PascalABC.NET: NuGet — Search and Add Package** searches configured package sources, then lets you select a package and version.
- **PascalABC.NET: NuGet — Package Versions** looks up versions of an exact package ID.
- **PascalABC.NET: NuGet — Restore Packages** restores packages for the current document, showing progress and a Cancel button. Details appear in the **PascalABC.NET NuGet** Output channel.

Selecting a version inserts or updates `{$package Package.Id 1.2.3}` in the editor; the edit can be undone. It does not save the document or restore packages automatically. The language server uses manual restore mode; a **NuGet: Restore** status item appears when the current document requires packages. Explicit Compile/Run remains a separate compiler operation and can perform its own package restore. Sources and caches follow the backend's NuGet.Config handling. This integration requires the unified server and does not add package support to the Framework compiler.

Known limitations of the current server: some routine calls with arguments can
resolve to the argument rather than the routine, and implementation lookup may
return no result for procedures in user units. Standard-library implementation
navigation and CLR metadata views are covered by the extension integration test.

To run that test after preparing `bin/` and compiling TypeScript, launch VS Code
with `--extensionDevelopmentPath=<extension repository>` and
`--extensionTestsPath=<extension repository>/scripts/test-navigation.cjs`, using
an isolated user-data directory for tests.

### Trying a local unified .NET 10 kit

Set `pascalabc.net10RuntimePath` in User Settings to the absolute path of a
prepared runtime directory, for example `D:\PABC_GIT\bin-net10`, and reload the
VS Code window. Both the .NET 10 compiler controller and the IntelliSense
server will run from that directory. It must contain their DLL, deps.json and
runtimeconfig.json files, shared dependencies, standard library sources and
prepared .NET 10 PCUs, and language resources. This setting does not build or
copy the kit and does not affect .NET Framework compilation. Clear the setting
and reload to return to the bundled .NET 10 runtime. Changes take effect only
after reload, so the controller and IntelliSense cannot switch kits separately.

This is a local development override. VSIX packaging imports its own kit via
the build-script parameter described below; it does not read VS Code settings.

## Source Code

The complete extension source is available at [github.com/pascalabcnet/pascalabcnet_vscode](https://github.com/pascalabcnet/pascalabcnet_vscode). Issues can be reported through the repository's [issue tracker](https://github.com/pascalabcnet/pascalabcnet_vscode/issues).

Both backends are maintained in the public [PascalABC.NET](https://github.com/pascalabcnet/pascalabcnet) repository. The old Tooling submodule is no longer used by the build scripts.

## Building from Source

The complete Windows packaging workflow requires Git, Node.js with npm, PowerShell, the .NET 10 SDK, and a Windows environment capable of running the .NET Framework 4.7.2 compiler-host smoke test.

Clone the extension repository:

```powershell
git clone https://github.com/pascalabcnet/pascalabcnet_vscode.git
cd pascalabcnet_vscode
```

Use a separate main PascalABC.NET checkout for compiler sources. Tooling submodule initialization is not needed for this build.

Install the pinned Node.js dependencies and compile TypeScript:

```powershell
npm ci
npm run compile
```

Open the repository in Visual Studio Code and press `F5` to launch an Extension Development Host. A complete generated runtime must already be present in `bin/`.

Prepare the unified Release kit in a separate main PascalABC.NET checkout:

```powershell
# Run these in the main PascalABC.NET repository, not in Tooling.
./scripts/build-net10-runtime.ps1 -Configuration Release
./scripts/rebuild-net10-standard-units.ps1 -Configuration Release -SkipBuild
```

Provide that prepared directory when building the extension. For example:

```powershell
./scripts/build-runtime.ps1 -PascalABCSourcePath D:\PABC_GIT -Net10RuntimePath D:\PABC_GIT\bin-net10
```

This imports the .NET 10 kit without rebuilding it and builds/tests Framework
directly from the supplied main sources. It accepts a prepared export as well as `bin-net10`.
Only manifest-listed files and PCUs corresponding to manifest-listed standard
sources are copied. Extra files in the source directory are ignored. The
imported manifest records hashes for the PCUs too. To require a specific input
snapshot, pass `-Net10ManifestSha256 <SHA256 of net10-runtime.manifest.json>`.

The language server is already included; the following command only validates it:

```powershell
./scripts/build-server.ps1
```

Import the kit, build Framework, restore Node.js dependencies, compile TypeScript,
and create and verify the complete VSIX:

```powershell
./scripts/build-vsix.ps1 -PascalABCSourcePath D:\PABC_GIT -Net10RuntimePath D:\PABC_GIT\bin-net10
```

Alternatively set `PABC_SOURCE_PATH` and `PABC_NET10_RUNTIME_PATH` before running `npm run package`.
The scripts fail if no kit is supplied; they never rebuild the .NET 10 backend
from Tooling as a fallback.

Command Prompt wrappers are also available:

```bat
scripts\build-runtime.cmd -PascalABCSourcePath D:\PABC_GIT -Net10RuntimePath D:\PABC_GIT\bin-net10
scripts\build-server.cmd
scripts\build-vsix.cmd -PascalABCSourcePath D:\PABC_GIT -Net10RuntimePath D:\PABC_GIT\bin-net10
```

The package filename is derived from the extension name and version, for example `multitarget-pascalabc-net-0.5.2.vsix`. Generated files under `bin/`, `out/`, and `.build/` are intentionally not committed. Reproducing a package requires the same prepared .NET 10 kit and the same main PascalABC.NET Framework sources.

## Updating the Backend

Use the intended main PascalABC.NET revision, prepare its .NET 10 kit and build
Framework from that checkout. Record the revision and local modifications when
reproducing a build. Build scripts do not switch, fetch or commit in that checkout.

To install it locally:

```powershell
code --install-extension .\multitarget-pascalabc-net-0.5.2.vsix
```

## Commands

| Command | Shortcut |
| --- | --- |
| PascalABC.NET: Compile and Run | `F9` |
| PascalABC.NET: Compile Current File | `Ctrl+F9` |
| PascalABC.NET: Show Output | — |
| PascalABC.NET: Open Compilation Output Folder | — |
| PascalABC.NET: Restart Compiler | — |
| PascalABC.NET: Select Compiler Target | — |

The keyboard shortcuts are active only for files with the `pascalabc` language identifier.

## License

This project is licensed under the GNU Lesser General Public License v3.0. See [LICENSE](LICENSE).
