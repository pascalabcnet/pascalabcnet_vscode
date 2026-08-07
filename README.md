# PascalABC.NET for Visual Studio Code

Visual Studio Code extension providing basic language support, compilation, and execution for PascalABC.NET programs.

## Features

- PascalABC.NET syntax highlighting and language configuration
- snippets for common language constructs
- completion for commonly used standard functions and collection types
- compilation diagnostics in the editor
- compile current file with `Ctrl+F9`
- compile and run with `F9`
- execution in an integrated terminal with console input support
- commands for restarting the compiler process and showing its output

## Requirements

The compilation bridge currently runs on Windows and requires the PascalABC.NET compiler runtime. Runtime binaries and libraries are generated or copied into `bin/` and are intentionally not stored in this repository.

The extension expects these entry points in `bin/` when the bundled runtime is used:

- `PABCCompilerController.exe`
- `ZMQServerPas.exe`
- the required PascalABC.NET compiler DLLs
- the `Lib` and `Lng` directories

The sources of the compilation bridge are stored in [`compiler-host`](compiler-host/):

- `PABCCompilerController.pas`
- `ZMQServerPas.pas`
- `CompileRunHelper.pas`

Temporary prebuilt NetMQ dependencies used to build and stage the compilation bridge are stored in `compiler-host/dependencies/netmq`. They are copied into the generated `bin/` directory during runtime preparation. In the future these dependencies can be built from source for the required platform.

PascalABC.NET itself is planned to be connected to this repository separately as a Git submodule. It is not included yet.

## Development

Install the Node.js dependencies and compile the TypeScript extension:

```powershell
npm install
npm run compile
```

Open the repository in Visual Studio Code and press `F5` to launch an Extension Development Host window.

Prepare a clean compiler runtime from a standard local PascalABC.NET installation:

```powershell
.\scripts\build-runtime.ps1
```

By default the script uses `C:\Program Files (x86)\PascalABC.NET`. A different installation can be selected with `-PascalABCPath`. The script stages and validates the new runtime before replacing the generated `bin/` directory.

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
code --install-extension .\pascalabc-net-0.0.1.vsix
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
