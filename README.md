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

The compilation bridge currently runs on Windows. Its compiler runtime is built from the PascalABC.NET sources pinned in the [`external/pascalabcnet`](external/pascalabcnet/) Git submodule. Generated runtime files are placed in `bin/` and are intentionally not stored in this repository.

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

Standard PascalABC.NET modules are rebuilt into PCU files by the same compiler build and packaged together with their Pascal sources. A reduced module set is used: `ABCHouse`, `ABCSprites`, `Arrays`, `BBCMicrobit`, `BlockFileOfT`, `ClientServer`, `Collections`, `Core`, `Events`, `MPI`, `Oberon00System`, `OpenCL`, `OpenCLABC`, `OpenGL`, `OpenGLABC`, `PointRect`, and `VCL` are currently omitted. `Graph3D` is included and expects its HelixToolkit dependencies to be available through the regular PascalABC.NET installation/GAC.

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
