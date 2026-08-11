# Change Log

All notable changes to the PascalABC.NET extension are documented in this file.

## 0.3.0 — Semantic IntelliSense

### Added

- Semantic completion after `.`, hover information, and signature help through the PascalABC.NET language server.
- A self-contained Windows x64 language server bundled with the extension.
- Reproducible scripts for publishing the pinned tooling backend and packaging it in the VSIX.

### Changed

- PascalABC.NET tooling is now pinned as a Git submodule and owns the nested PascalABC.NET compiler source submodule.
- The extension communicates with IntelliSense through the standard Language Server Protocol over stdio.
- Member completion lists show properties and fields before methods.
- Language snippets are context-aware and are not offered after member-access dots.

### Removed

- The temporary hard-coded TypeScript completion list; all IntelliSense completion now comes from the semantic language server.

### Fixed

- Language server initialization with current VS Code releases by using an LSP client protocol version compatible with the pinned tooling backend.
- Signature help for global standard routines such as `Print` by bundling the compatible PascalABC.NET standard library with the language server.
- Static .NET 10 type completion such as `DateTime.`; completion no longer fails with LSP error `-32000`.
- Completion for modern .NET 10 array extension methods such as `AsSpan`.

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
