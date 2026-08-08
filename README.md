# PascalABC.NET for Visual Studio Code

The official Visual Studio Code extension for writing, compiling, and running PascalABC.NET programs.

## About PascalABC.NET

PascalABC.NET is a modern Pascal programming language that combines the simplicity and clarity of classic Pascal with contemporary language features and the capabilities of the Microsoft .NET platform.

It supports procedural, object-oriented, and functional programming styles, making it well suited for teaching modern programming—from a beginner's first programs to university-level courses. Its concise and readable syntax helps students focus on algorithms, problem solving, and software design.

PascalABC.NET is also a practical tool for console applications, educational and scientific projects, and general-purpose programming. It is free software distributed under the GNU LGPLv3 license.

## Extension Features

- PascalABC.NET syntax highlighting and language configuration
- snippets for common language constructs
- completion for commonly used standard functions and collection types
- compilation diagnostics in the editor
- compile current file with `Ctrl+F9`
- compile and run with `F9`
- execution in an integrated terminal with console input support
- commands for restarting the compiler process and showing its output

## Getting Started

1. Create a file using **File → New File → PascalABC.NET File**, or open an existing `.pas` file.
2. Press `F9` to compile and run it.
3. Use the integrated terminal for console input and program output.

Compiler errors are displayed directly in the editor. `Ctrl+F9` compiles the current file without running it.

## Platform Support

This preview currently supports Windows. The compiler runtime required for ordinary PascalABC.NET programs is bundled with the extension, so a separate installation is not required for the basic compile-and-run workflow.

Some optional modules depend on components normally installed with the full PascalABC.NET distribution. For example, `Graph3D` expects HelixToolkit and `NUnitABC` expects NUnit.

## Development

Clone the repository together with its submodule:

```powershell
git clone --recurse-submodules https://github.com/pascalabcnet/pascalabcnet_vscode.git
```

For an existing clone, initialize or update the pinned submodule with:

```powershell
git submodule update --init --recursive
```

Install the Node.js dependencies and compile the TypeScript extension:

```powershell
npm install
npm run compile
```

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

To prepare the runtime, restore Node.js dependencies, compile TypeScript, and package the complete VSIX in one step from Command Prompt, run:

```bat
scripts\build-vsix.cmd
```

The resulting file is named from the extension version in `package.json`, for example `pascalabc-net-0.1.0.vsix`.

## Building a VSIX

Before packaging, make sure that `bin/` contains the complete compiler runtime required by the extension. Then run:

```powershell
npm install
npm run compile
npx --yes @vscode/vsce package
```

The generated `.vsix` file is ignored by Git.

To install it locally:

```powershell
code --install-extension .\pascalabc-net-0.1.0.vsix
```

## Commands

| Command | Shortcut |
| --- | --- |
| PascalABC.NET: Compile and Run | `F9` |
| PascalABC.NET: Compile Current File | `Ctrl+F9` |
| PascalABC.NET: Show Output | — |
| PascalABC.NET: Restart Compiler | — |

The keyboard shortcuts are active only for files with the `pascalabc` language identifier.

## License

This project is licensed under the GNU Lesser General Public License v3.0. See [LICENSE](LICENSE).
