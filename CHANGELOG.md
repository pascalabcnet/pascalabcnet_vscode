# Change Log

All notable changes to the PascalABC.NET extension are documented in this file.

## 0.2.0 — Dual Compiler Targets

### Added

- Selectable .NET Framework 4.7.2 and .NET 10 compiler targets.
- Independent compiler assemblies, standard PCU modules, and language resources for each target.
- Status bar compiler selector with the current target highlighted.
- .NET 10 program execution through `dotnet` in the integrated terminal.
- Multi-targeted C# implementations of `PABCCompilerController` and `ZMQServerPas`.

### Changed

- Updated the bundled PascalABC.NET compiler sources through the pinned Git submodule.
- Improved compiler runtime validation and reproducible runtime packaging.
- Improved compiler error visibility in the PascalABC.NET output channel.

### Fixed

- Compilation and execution of files with spaces and non-ASCII characters in their paths.
- Compilation of existing local files opened through non-`file` editor URI schemes.
- Compiler target selection now initially highlights the active target.
- Runtime processes are detected correctly for both native executables and `dotnet` hosts.

## 0.1.0 — Preview

Initial public preview.

> The bundled Windows compiler runtime is built from the PascalABC.NET sources pinned as a Git submodule. Standard PCU modules are rebuilt with the same compiler build.

### Added

- PascalABC.NET syntax highlighting, language configuration, and snippets.
- Completion for commonly used standard functions and collection types.
- Compilation of the current PascalABC.NET file with editor diagnostics.
- Compile and Run command with console input in the integrated terminal.
- Commands for creating, opening, and saving PascalABC.NET files.
- Commands for showing compiler output and restarting the compiler process.
- Reproducible scripts for preparing the compiler runtime and building the VSIX package.
