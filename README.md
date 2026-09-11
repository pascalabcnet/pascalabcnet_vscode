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
| .NET 10 | Windows and Linux; modern .NET applications and current platform capabilities | runs the generated `.exe` with `dotnet` |

Select the target from the **PascalABC.NET** item in the status bar or run **PascalABC.NET: Select Compiler Target** from the Command Palette. Each target has its own compiler assemblies and compatible precompiled standard units.

## Architecture and Local Tooling

This is a development-tool extension, not only a syntax-highlighting package. The VSIX contains the PascalABC.NET compiler and the local tooling binaries required for IntelliSense and compilation.

The TypeScript extension starts these components as child processes when needed:

- `PascalABCNet.LanguageServer.dll` runs through `dotnet` and provides semantic IntelliSense over the Language Server Protocol using stdio.
- `PABCCompilerController.exe` is used for the .NET Framework target; its .NET 10 counterpart is `PABCCompilerController.dll`, launched through `dotnet`. The controller accepts JSON Lines requests from the extension and manages compiler-worker lifetime.
- `ZMQServerPas.exe` or `ZMQServerPas.dll` is the compiler worker. It loads the selected PascalABC.NET compiler runtime and performs compilation outside the VS Code extension host.

The controller selects an available loopback TCP port and communicates with its worker through local NetMQ request/reply messaging. The corresponding NetMQ dependencies, including `NaCl.dll`, are bundled because they are required by this IPC layer.

## Runtime Behavior

**Compile Current File** saves a modified document, starts the selected controller lazily, sends a compile request, and publishes the returned PascalABC.NET diagnostics in VS Code.

**Compile and Run** uses the same compilation path. After successful compilation it starts the generated program in the integrated terminal so that console input and output remain available. The program is run directly for .NET Framework or through `dotnet` for .NET 10; it is not executed by the language server or compiler worker.

**Restart Compiler** stops the current controller and its worker, clears compiler diagnostics, and leaves the next compilation to start a fresh controller lazily. Closing VS Code also disposes the controller and language client.

## Getting Started

1. Create a file using **File → New File → PascalABC.NET File**, or open an existing `.pas` file.
2. If needed, select **.NET Framework 4.7.2** or **.NET 10** from the PascalABC.NET status bar item.
3. Press `F9` to compile and run it.
4. Use the integrated terminal for console input and program output.

Compiler errors are displayed directly in the editor. `Ctrl+F9` compiles the current file without running it.

## Platform Support

This preview supports Windows and Linux. The compiler runtime required for ordinary PascalABC.NET programs is bundled with the extension, so a separate PascalABC.NET installation is not required for the basic compile-and-run workflow.

On Windows, both the classic .NET Framework 4.7.2 target and the modern .NET 10 target are available. On Linux, the extension automatically uses .NET 10 and does not offer the Windows-only .NET Framework target. The .NET 10 runtime must be installed on the computer; both the compiler and generated programs are launched through `dotnet`.

Some optional modules depend on components normally installed with the full PascalABC.NET distribution. For example, `Graph3D` expects HelixToolkit and `NUnitABC` expects NUnit.

## IntelliSense

Semantic language features are provided by the separate [PascalABC.NET Tooling](https://github.com/pascalabcnet/pascalabcnet-tooling) backend. The extension starts its portable framework-dependent .NET 10 language server through `dotnet` as an independent process and communicates with it through the standard Language Server Protocol over stdio.

The language server owns document synchronization and PascalABC.NET semantic analysis, including global and member completion. The existing compiler controller remains an independent process and continues to handle explicit Compile and Run commands.

## Source Code

The complete extension source is available at [github.com/pascalabcnet/pascalabcnet_vscode](https://github.com/pascalabcnet/pascalabcnet_vscode). Issues can be reported through the repository's [issue tracker](https://github.com/pascalabcnet/pascalabcnet_vscode/issues).

The semantic backend is maintained in the public [PascalABC.NET Tooling](https://github.com/pascalabcnet/pascalabcnet-tooling) repository.

## Building from Source

The complete Windows packaging workflow requires Git, Node.js with npm, PowerShell, the .NET 10 SDK, and a Windows environment capable of running the .NET Framework 4.7.2 compiler-host smoke test.

Clone the repository and its transitive submodules:

```powershell
git clone --recurse-submodules https://github.com/pascalabcnet/pascalabcnet_vscode.git
cd pascalabcnet_vscode
```

For an existing clone, initialize the pinned revisions with:

```powershell
git submodule update --init --recursive
```

Install the pinned Node.js dependencies and compile TypeScript:

```powershell
npm ci
npm run compile
```

Open the repository in Visual Studio Code and press `F5` to launch an Extension Development Host. A complete generated runtime must already be present in `bin/`.

Build and validate both compiler runtimes:

```powershell
./scripts/build-runtime.ps1
```

Publish the framework-dependent .NET 10 language server and merge it into the shared `bin/net10/` runtime:

```powershell
./scripts/build-server.ps1
```

Build the runtimes and language server, restore Node.js dependencies, compile TypeScript, and create the complete VSIX:

```powershell
npm run package
```

Command Prompt wrappers are also available:

```bat
scripts\build-runtime.cmd
scripts\build-server.cmd
scripts\build-vsix.cmd
```

The package filename is derived from the extension name and version, for example `multitarget-pascalabc-net-0.5.0.vsix`. Generated files under `bin/`, `out/`, and `.build/` are intentionally not committed; the scripts reconstruct them from the pinned public source revisions.

## Updating the Tooling Backend

The VS Code repository pins only `externals/pascalabcnet-tooling`. The tooling repository in turn pins the compatible PascalABC.NET compiler sources.

The update order is:

1. update and verify the PascalABC.NET submodule pointer in the tooling repository;
2. commit and test the tooling repository;
3. update the tooling submodule pointer in this repository;
4. initialize the pinned nested submodule with `git submodule update --init --recursive` and run the full extension build.

Do not update `externals/pascalabcnet-tooling/pascalabcnet` directly from this repository, and do not use `git submodule update --remote` in the reproducible build flow.

To install it locally:

```powershell
code --install-extension .\multitarget-pascalabc-net-0.5.0.vsix
```

## Commands

| Command | Shortcut |
| --- | --- |
| PascalABC.NET: Compile and Run | `F9` |
| PascalABC.NET: Compile Current File | `Ctrl+F9` |
| PascalABC.NET: Show Output | — |
| PascalABC.NET: Restart Compiler | — |
| PascalABC.NET: Select Compiler Target | — |

The keyboard shortcuts are active only for files with the `pascalabc` language identifier.

## License

This project is licensed under the GNU Lesser General Public License v3.0. See [LICENSE](LICENSE).
