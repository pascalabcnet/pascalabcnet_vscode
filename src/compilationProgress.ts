import * as vscode from 'vscode';
import * as path from 'path';

export interface CompilerProgressEvent {
    id: number;
    event: 'compilerState' | 'compilerMessage';
    state?: string;
    fileName?: string;
    message?: string;
    linesCompiled?: number;
    errorCount?: number;
    warningCount?: number;
    nuGetStage?: string;
    nuGetInstalledCount?: number;
}

export class CompilationProgress implements vscode.Disposable {
    private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    private readonly timer: ReturnType<typeof setTimeout>;

    constructor(private readonly output: vscode.OutputChannel) {
        this.status.name = 'PascalABC.NET Compilation';
        this.status.text = '$(sync~spin) PascalABC.NET: компиляция…';
        this.timer = setTimeout(() => this.status.show(), 600);
    }

    update(event: CompilerProgressEvent): void {
        if (event.event === 'compilerMessage') {
            if (event.message) { this.output.appendLine(event.message); }
            return;
        }
        // BeginCompileFile is raised when constructing a syntax tree from
        // source; ReadPCUFile is raised when the PCU reader starts reading it.
        // A failed PCU read can legitimately be followed by source compilation.
        if (event.fileName && event.state === 'BeginCompileFile') {
            this.output.appendLine(`Компиляция исходника: ${event.fileName}`);
        } else if (event.fileName && event.state === 'ReadPCUFile') {
            this.output.appendLine(`Чтение PCU: ${event.fileName}`);
        }
        const nuget = event.state === 'NuGetRestoreProgress';
        const file = event.fileName ? path.basename(event.fileName) : '';
        this.status.text = `$(sync~spin) PascalABC.NET: ${nuget ? 'NuGet' : 'компиляция'}${file ? ': ' + file : '…'}`;
        this.status.tooltip = nuget
            ? `NuGet: ${event.fileName || ''}; установлено: ${event.nuGetInstalledCount ?? 0}`
            : `Строк: ${event.linesCompiled ?? 0}; ошибок: ${event.errorCount ?? 0}; предупреждений: ${event.warningCount ?? 0}`;
    }

    dispose(): void {
        clearTimeout(this.timer);
        this.status.dispose();
    }
}
