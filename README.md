# PascalABC.NET for Visual Studio Code

The official Visual Studio Code extension for writing, compiling, and running PascalABC.NET programs.

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

## Two Compiler Targets

The extension includes two independent PascalABC.NET compiler runtimes:

| Target | Best suited for | Program launch |
| --- | --- | --- |
| .NET Framework 4.7.2 | Windows; compatibility with the classic PascalABC.NET environment | runs the generated `.exe` directly |
| .NET 10 | Windows and Linux; modern .NET applications and current platform capabilities | runs the generated `.exe` with `dotnet` |

Select the target from the **PascalABC.NET** item in the status bar or run **PascalABC.NET: Select Compiler Target** from the Command Palette. Each target has its own compiler assemblies and compatible precompiled standard units.

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

## Development

Clone the repository together with its submodule:

```powershell
git clone --recurse-submodules https://github.com/pascalabcnet/pascalabcnet_vscode.git
```

For an existing clone, initialize or update the pinned submodule with:

```powershell
git submodule update --init --recursive
```

Install the pinned Node.js dependencies and compile the TypeScript extension:

```powershell
npm ci
npm run compile
```

Publish the portable .NET 10 language server and compile the extension client with:

```powershell
npm run build
```

The generated language server is merged into the shared `bin/net10/` runtime, reusing the same compiler assemblies and standard library. The generated compiler runtime in `bin/` is not stored in Git.

Open the repository in Visual Studio Code and press `F5` to launch an Extension Development Host window.

Preparing the runtime requires the .NET SDK used by the pinned PascalABC.NET sources. Build a clean runtime from the submodule with:

```powershell
.\scripts\build-runtime.ps1
```

From Command Prompt (`cmd.exe`), use the wrapper:

```bat
scripts\build-runtime.cmd
```

The script builds the compiler solution, rebuilds the standard PCU modules, builds the controller and worker, then stages and validates the new runtime before atomically replacing the generated `bin/` directory. A different PascalABC.NET source checkout can be selected with `-PascalABCSourcePath`.

To publish only the language server, run:

```powershell
.\scripts\build-server.ps1
```

From Command Prompt, use `scripts\build-server.cmd`.

To prepare the runtime, restore Node.js dependencies, compile TypeScript, and package the complete VSIX in one step from Command Prompt, run:

```bat
scripts\build-vsix.cmd
```

The resulting file is named from the extension version in `package.json`, for example `pascalabc-net-0.3.0.vsix`.

## Building a VSIX

The recommended command builds the compiler runtime and language server, restores Node.js dependencies, compiles TypeScript, and packages the VSIX:

```powershell
.\scripts\build-vsix.ps1
```

From Command Prompt, use `scripts\build-vsix.cmd`.

If all generated components have already been prepared, the equivalent final packaging steps are:

```powershell
npm ci
npm run compile
npx --yes @vscode/vsce package
```

Before invoking `vsce` directly, `bin/net-framework/` and `bin/net10/` must contain their complete generated runtimes, including the language server in `bin/net10/`. The generated `.vsix` file is ignored by Git.

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
code --install-extension .\pascalabc-net-0.3.0.vsix
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
