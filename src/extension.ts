import * as vscode from 'vscode';
import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';

let controller: CompilerController | undefined;
let runTerminal: vscode.Terminal | undefined;
let activeRunExecution: vscode.TerminalShellExecution | undefined;
let compilationInProgress = false;

type CompilerTarget = 'net-framework' | 'net10';

interface CompilerProfile {
    target: CompilerTarget;
    label: string;
    runtimeDirectory: string;
    command: string;
    args: string[];
    requiredComponents: readonly string[];
}

const legacyRequiredCompilerComponents = [
    'ZMQServerPas.exe',
    'AsyncIO.dll',
    'Compiler.dll',
    'CompilerTools.dll',
    'Errors.dll',
    'LambdaAnySynToSemConverter.dll',
    'LanguageIntegrator.dll',
    'Localization.dll',
    'NaCl.dll',
    'NETGenerator.dll',
    'NetMQ.dll',
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
    'System.Buffers.dll',
    'System.Memory.dll',
    'System.Numerics.Vectors.dll',
    'System.Runtime.CompilerServices.Unsafe.dll',
    'System.Threading.Tasks.Extensions.dll',
    'System.ValueTuple.dll',
    'TreeConverter.dll',
    'Lib',
    'Lng'
] as const;

const modernRequiredCompilerComponents = [
    'PABCCompilerController.dll',
    'PABCCompilerController.deps.json',
    'PABCCompilerController.runtimeconfig.json',
    'ZMQServerPas.dll',
    'ZMQServerPas.deps.json',
    'ZMQServerPas.runtimeconfig.json',
    'Compiler.dll',
    'CompilerTools.dll',
    'Errors.dll',
    'NETGenerator.dll',
    'NetMQ.dll',
    'PascalABCLanguageInfo.dll',
    'PascalABCParser.dll',
    'SemanticTree.dll',
    'SyntaxTree.dll',
    'TreeConverter.dll',
    'Lib',
    'Lng'
] as const;

interface CompilerDiagnostic {
    fileName: string;
    line: number;
    column: number;
    severity: string;
    message: string;
}

interface CompileResponse {
    id: number;
    success: boolean;
    outputFile?: string;
    message?: string;
    diagnostics?: CompilerDiagnostic[];
    fileName?: string;
    compilationCount?: number;
    workerPid?: number;
    workingSetMB?: number;
    errorType?: string;
}

interface PendingRequest {
    resolve: (response: CompileResponse) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

class CompilerController implements vscode.Disposable {
    private process: ChildProcessWithoutNullStreams | undefined;
    private lineReader: readline.Interface | undefined;
    private nextRequestId = 1;
    private readonly pending = new Map<number, PendingRequest>();

    public constructor(
        private readonly profile: CompilerProfile,
        private readonly output: vscode.OutputChannel
    ) {
    }

    public async compile(fileName: string): Promise<CompileResponse> {
        await this.ensureStarted();

        return this.sendRequest({
            command: 'compile',
            fileName
        });
    }

    private async ensureStarted(): Promise<void> {
        if (this.process && !this.process.killed && this.process.exitCode === null) {
            return;
        }

        const commandDescription = [this.profile.command, ...this.profile.args]
            .map(argument => argument.includes(' ') ? `"${argument}"` : argument)
            .join(' ');
        this.output.appendLine(`Starting compiler controller: ${commandDescription}`);

        this.process = spawn(
            this.profile.command,
            this.profile.args,
            {
                cwd: this.profile.runtimeDirectory,
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe']
            }
        );

        this.process.stderr.setEncoding('utf8');
        this.process.stderr.on('data', data => {
            this.output.append(data.toString());
        });

        this.process.on('error', error => {
            this.failAllRequests(
                new Error(`Failed to start compiler controller: ${error.message}`)
            );
        });

        this.process.on('exit', (code, signal) => {
            this.output.appendLine(
                `Compiler controller stopped. Code=${String(code)}, signal=${String(signal)}`
            );

            this.process = undefined;
            this.lineReader?.close();
            this.lineReader = undefined;

            this.failAllRequests(
                new Error('Compiler controller terminated unexpectedly')
            );
        });

        this.lineReader = readline.createInterface({
            input: this.process.stdout,
            crlfDelay: Infinity
        });

        this.lineReader.on('line', line => {
            this.handleResponseLine(line);
        });

        const response = await this.sendRequest(
            { command: 'ping' },
            15_000
        );

        if (!response.success || response.result !== 'PONG') {
            throw new Error('Compiler controller did not return PONG');
        }

        this.output.appendLine(
            `Compiler controller ready. Worker PID=${String(response.workerPid)}`
        );
    }

    private sendRequest(
        request: Record<string, unknown>,
        timeoutMs = 5 * 60 * 1000
    ): Promise<CompileResponse & Record<string, unknown>> {
        if (!this.process || this.process.exitCode !== null) {
            return Promise.reject(
                new Error('Compiler controller is not running')
            );
        }

        const id = this.nextRequestId++;
        const message = JSON.stringify({ id, ...request });

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`Compiler request ${id} timed out`));
            }, timeoutMs);

            this.pending.set(id, {
                resolve: resolve as (response: CompileResponse) => void,
                reject,
                timer
            });

            this.process!.stdin.write(message + '\n', 'utf8', error => {
                if (!error) {
                    return;
                }

                const pendingRequest = this.pending.get(id);

                if (pendingRequest) {
                    clearTimeout(pendingRequest.timer);
                    this.pending.delete(id);
                    pendingRequest.reject(error);
                }
            });
        });
    }

    private handleResponseLine(line: string): void {
        let response: CompileResponse;

        try {
            response = JSON.parse(line) as CompileResponse;
        } catch {
            this.output.appendLine(
                `Invalid controller output: ${line}`
            );
            return;
        }

        const pendingRequest = this.pending.get(response.id);

        if (!pendingRequest) {
            this.output.appendLine(
                `Unexpected response id: ${response.id}`
            );
            return;
        }

        clearTimeout(pendingRequest.timer);
        this.pending.delete(response.id);
        pendingRequest.resolve(response);
    }

    private failAllRequests(error: Error): void {
        for (const request of this.pending.values()) {
            clearTimeout(request.timer);
            request.reject(error);
        }

        this.pending.clear();
    }

    public dispose(): void {
        this.lineReader?.close();
        this.lineReader = undefined;

        const process = this.process;
        this.process = undefined;

        if (!process || process.exitCode !== null) {
            return;
        }

        try {
            const id = this.nextRequestId++;
            process.stdin.write(
                JSON.stringify({
                    id,
                    command: 'shutdown'
                }) + '\n'
            );
        } catch {
            // The process may already be terminating.
        }

        setTimeout(() => {
            if (process.exitCode === null) {
                process.kill();
            }
        }, 1000);
    }
}

interface PingResponse extends CompileResponse {
    result?: string;
}

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel(
        'PascalABC.NET',
        'pascalabc-output'
    );
    const diagnostics =
        vscode.languages.createDiagnosticCollection('pascalabc');
    const compilerStatus = vscode.window.createStatusBarItem(
        vscode.StatusBarAlignment.Right,
        100
    );
    compilerStatus.command = 'pascalabc.selectCompilerTarget';
    compilerStatus.name = 'PascalABC.NET Compiler';
    updateCompilerStatus(compilerStatus);
    const completionProvider =
        vscode.languages.registerCompletionItemProvider(
            { language: 'pascalabc' },
            new PascalABCCompletionProvider()
        );
    context.subscriptions.push(
        output,
        diagnostics,
        compilerStatus,
        completionProvider
    );

    context.subscriptions.push(
        vscode.window.onDidCloseTerminal(terminal => {
            if (terminal === runTerminal) {
                runTerminal = undefined;
                activeRunExecution = undefined;
            }
        })
    );
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => {
            updateCompilerStatus(compilerStatus);
        })
    );

    const compileCommand = vscode.commands.registerCommand(
        'pascalabc.compileCurrentFile',
        () => compileActiveDocument(context, output, diagnostics, false)
    );

    const compileAndRunCommand = vscode.commands.registerCommand(
        'pascalabc.compileAndRun',
        () => compileActiveDocument(context, output, diagnostics, true)
    );

    const showOutputCommand = vscode.commands.registerCommand(
        'pascalabc.showOutput',
        () => output.show(false)
    );

    const restartCompilerCommand = vscode.commands.registerCommand(
        'pascalabc.restartCompiler',
        () => {
            const wasRunning = controller !== undefined;

            controller?.dispose();
            controller = undefined;
            diagnostics.clear();

            output.appendLine('');
            output.appendLine(
                wasRunning
                    ? 'Compiler controller stopped. It will start again on the next compilation.'
                    : 'Compiler controller is not running. It will start on the next compilation.'
            );
            output.show(true);
        }
    );

    const selectCompilerTargetCommand = vscode.commands.registerCommand(
        'pascalabc.selectCompilerTarget',
        async () => {
            const currentTarget = getCompilerTarget();
            const selected = await vscode.window.showQuickPick(
                [
                    {
                        label: '.NET Framework 4.7.2',
                        description: 'Classic PascalABC.NET runtime',
                        target: 'net-framework' as CompilerTarget
                    },
                    {
                        label: '.NET 10',
                        description: 'Modern cross-platform runtime',
                        target: 'net10' as CompilerTarget
                    }
                ],
                {
                    title: 'Select PascalABC.NET compiler',
                    placeHolder: currentTarget === 'net10'
                        ? '.NET 10'
                        : '.NET Framework 4.7.2'
                }
            );

            if (!selected || selected.target === currentTarget) {
                return;
            }

            await vscode.workspace.getConfiguration('pascalabc').update(
                'compilerTarget',
                selected.target,
                vscode.ConfigurationTarget.Global
            );
        }
    );

    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(event => {
            if (!event.affectsConfiguration('pascalabc.compilerTarget')) {
                return;
            }

            controller?.dispose();
            controller = undefined;
            diagnostics.clear();
            updateCompilerStatus(compilerStatus);
            output.appendLine(
                `Compiler target changed to ${getCompilerTargetLabel()}.`
            );
        })
    );

    const newFileCommand = vscode.commands.registerCommand(
        'pascalabc.newFile',
        async () => {
            const fileUri = getNewProgramUri();
            let document = await vscode.workspace.openTextDocument(fileUri);

            if (document.languageId !== 'pascalabc') {
                document = await vscode.languages.setTextDocumentLanguage(
                    document,
                    'pascalabc'
                );
            }

            const editor = await vscode.window.showTextDocument(document);
            await editor.edit(editBuilder => {
                editBuilder.insert(
                    new vscode.Position(0, 0),
                    'begin\n  \nend.\n'
                );
            });

            const position = new vscode.Position(1, 2);

            editor.selection = new vscode.Selection(position, position);
        }
    );

    const openFileCommand = vscode.commands.registerCommand(
        'pascalabc.openFile',
        async () => {
            const selectedFiles = await vscode.window.showOpenDialog({
                canSelectFiles: true,
                canSelectFolders: false,
                canSelectMany: false,
                openLabel: 'Открыть PascalABC.NET файл',
                filters: {
                    'PascalABC.NET': ['pas']
                }
            });

            if (!selectedFiles || selectedFiles.length === 0) {
                return;
            }

            const document = await vscode.workspace.openTextDocument(
                selectedFiles[0]
            );

            await vscode.window.showTextDocument(document);
        }
    );

    const saveFileCommand = vscode.commands.registerCommand(
        'pascalabc.saveFile',
        async () => {
            const document = vscode.window.activeTextEditor?.document;

            if (!document) {
                void vscode.window.showErrorMessage(
                    'Нет активного файла для сохранения.'
                );
                return;
            }

            const savedDocument = await saveDocument(document);

            if (!savedDocument && document.uri.scheme !== 'untitled') {
                void vscode.window.showErrorMessage(
                    'Не удалось сохранить файл.'
                );
            }
        }
    );

    context.subscriptions.push(
        compileCommand,
        compileAndRunCommand,
        showOutputCommand,
        restartCompilerCommand,
        selectCompilerTargetCommand,
        newFileCommand,
        openFileCommand,
        saveFileCommand
    );
}

function getNewProgramUri(): vscode.Uri {
    const activeDocument = vscode.window.activeTextEditor?.document;
    let directory: string | undefined;

    if (activeDocument && path.isAbsolute(activeDocument.fileName)) {
        directory = path.dirname(activeDocument.fileName);
    } else {
        directory = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    }

    for (let index = 1; ; index++) {
        const fileName = `Program${index}.pas`;
        const candidatePath = directory
            ? path.join(directory, fileName)
            : fileName;
        const normalizedCandidate =
            path.normalize(candidatePath).toLocaleLowerCase();
        const isAlreadyOpen = vscode.workspace.textDocuments.some(document =>
            directory
                ? path.normalize(document.fileName).toLocaleLowerCase() ===
                    normalizedCandidate
                : path.basename(document.fileName).toLocaleLowerCase() ===
                    fileName.toLocaleLowerCase()
        );

        if (!isAlreadyOpen && (!directory || !fs.existsSync(candidatePath))) {
            return directory
                ? vscode.Uri.file(candidatePath).with({ scheme: 'untitled' })
                : vscode.Uri.parse(`untitled:${fileName}`);
        }
    }
}

async function saveDocument(
    document: vscode.TextDocument
): Promise<vscode.TextDocument | undefined> {
    if (document.uri.scheme === 'untitled') {
        await vscode.commands.executeCommand(
            'workbench.action.files.saveAs'
        );

        const savedDocument = vscode.window.activeTextEditor?.document;

        return savedDocument?.uri.scheme === 'file'
            ? savedDocument
            : undefined;
    }

    return await document.save() ? document : undefined;
}

interface CompletionDefinition {
    label: string;
    insertText: string;
    detail: string;
    documentation: string;
    kind: vscode.CompletionItemKind;
}

const globalCompletions: CompletionDefinition[] = [
    {
        label: 'Println',
        insertText: 'Println(${1:value})',
        detail: 'procedure Println(params values: array of object)',
        documentation: 'Выводит значения и переводит строку.',
        kind: vscode.CompletionItemKind.Function
    },
    {
        label: 'ReadInteger',
        insertText: 'ReadInteger()',
        detail: 'function ReadInteger: integer',
        documentation: 'Считывает целое число из консоли.',
        kind: vscode.CompletionItemKind.Function
    },
    {
        label: 'ReadReal',
        insertText: 'ReadReal()',
        detail: 'function ReadReal: real',
        documentation: 'Считывает вещественное число из консоли.',
        kind: vscode.CompletionItemKind.Function
    },
    {
        label: 'Range',
        insertText: 'Range(${1:fromValue}, ${2:toValue})',
        detail: 'function Range(fromValue, toValue: integer): sequence of integer',
        documentation: 'Создаёт последовательность целых чисел.',
        kind: vscode.CompletionItemKind.Function
    },
    {
        label: 'Arr',
        insertText: 'Arr(${1:items})',
        detail: 'function Arr<T>(params items: array of T): array of T',
        documentation: 'Создаёт массив из перечисленных элементов.',
        kind: vscode.CompletionItemKind.Function
    },
    {
        label: 'SetOf',
        insertText: 'SetOf(${1:items})',
        detail: 'function SetOf<T>(params items: array of T): NewSet<T>',
        documentation: 'Создаёт множество из перечисленных элементов.',
        kind: vscode.CompletionItemKind.Function
    },
    {
        label: 'Lst',
        insertText: 'Lst(${1:items})',
        detail: 'function Lst<T>(params items: array of T): List<T>',
        documentation: 'Создаёт список из элементов или последовательности.',
        kind: vscode.CompletionItemKind.Function
    },
    {
        label: 'HSet',
        insertText: 'HSet(${1:items})',
        detail: 'function HSet<T>(params items: array of T): HashSet<T>',
        documentation: 'Создаёт множество уникальных элементов.',
        kind: vscode.CompletionItemKind.Function
    },
    {
        label: 'Dict',
        insertText: 'Dict(${1:pairs})',
        detail: 'function Dict<TKey, TValue>(params pairs): Dictionary<TKey, TValue>',
        documentation: 'Создаёт словарь из пар ключ-значение.',
        kind: vscode.CompletionItemKind.Function
    },
    {
        label: 'List',
        insertText: 'List<${1:integer}>',
        detail: 'System.Collections.Generic.List<T>',
        documentation: 'Изменяемый список элементов.',
        kind: vscode.CompletionItemKind.Class
    },
    {
        label: 'HashSet',
        insertText: 'HashSet<${1:integer}>',
        detail: 'System.Collections.Generic.HashSet<T>',
        documentation: 'Множество уникальных элементов.',
        kind: vscode.CompletionItemKind.Class
    },
    {
        label: 'Stack',
        insertText: 'Stack<${1:integer}>',
        detail: 'System.Collections.Generic.Stack<T>',
        documentation: 'Коллекция LIFO.',
        kind: vscode.CompletionItemKind.Class
    },
    {
        label: 'Queue',
        insertText: 'Queue<${1:integer}>',
        detail: 'System.Collections.Generic.Queue<T>',
        documentation: 'Коллекция FIFO.',
        kind: vscode.CompletionItemKind.Class
    }
];

class PascalABCCompletionProvider implements vscode.CompletionItemProvider {
    public provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.CompletionItem[] {
        const linePrefix = document.lineAt(position).text.slice(
            0,
            position.character
        );
        if (/\.\s*[\p{L}\w]*$/u.test(linePrefix)) {
            return [];
        }

        const wordMatch = linePrefix.match(/[\p{L}\w]+$/u);
        const prefix = wordMatch?.[0].toLocaleLowerCase() ?? '';
        const matchingCompletions = globalCompletions.filter(definition =>
            definition.label.toLocaleLowerCase().startsWith(prefix)
        );

        return matchingCompletions.map((definition, index) => {
            const item = new vscode.CompletionItem(
                definition.label,
                definition.kind
            );

            item.insertText = new vscode.SnippetString(definition.insertText);
            item.detail = definition.detail;
            item.documentation = new vscode.MarkdownString(
                definition.documentation
            );
            item.filterText = definition.label;
            item.sortText = index.toString().padStart(3, '0');

            return item;
        });
    }
}

async function compileActiveDocument(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    diagnostics: vscode.DiagnosticCollection,
    runAfterSuccess: boolean
): Promise<void> {
    if (compilationInProgress) {
        void vscode.window.showInformationMessage(
            'PascalABC.NET: компиляция уже выполняется.'
        );
        return;
    }

    compilationInProgress = true;

    try {
        await performCompileActiveDocument(
            context,
            output,
            diagnostics,
            runAfterSuccess
        );
    } finally {
        compilationInProgress = false;
    }
}

async function performCompileActiveDocument(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    diagnostics: vscode.DiagnosticCollection,
    runAfterSuccess: boolean
): Promise<void> {
            const editor = vscode.window.activeTextEditor;

            if (!editor) {
                void vscode.window.showErrorMessage(
                    'Нет активного файла для компиляции.'
                );
                return;
            }

            let document = editor.document;

            if (document.uri.scheme === 'untitled') {
                const saveAction = await vscode.window.showInformationMessage(
                    'Сначала сохраните файл PascalABC.NET на диске.',
                    'Сохранить'
                );

                if (saveAction !== 'Сохранить') {
                    return;
                }

                const savedDocument = await saveDocument(document);

                if (!savedDocument) {
                    return;
                }

                document = savedDocument;
            }

            if (document.uri.scheme !== 'file') {
                void vscode.window.showErrorMessage(
                    'Можно компилировать только файл на диске.'
                );
                return;
            }

            if (path.extname(document.fileName).toLowerCase() !== '.pas') {
                void vscode.window.showErrorMessage(
                    'Текущий файл не имеет расширения .pas.'
                );
                return;
            }

            if (document.isDirty) {
                const saved = await document.save();

                if (!saved) {
                    void vscode.window.showErrorMessage(
                        'Не удалось сохранить файл.'
                    );
                    return;
                }
            }

            diagnostics.delete(document.uri);

            const compilerProfile = resolveCompilerProfile(context);

            if (!controller) {
                const missingComponents =
                    findMissingCompilerComponents(compilerProfile);

                if (missingComponents.length > 0) {
                    output.appendLine('');
                    output.appendLine(
                        'PascalABC.NET compiler components were not found.'
                    );
                    output.appendLine('Missing components:');

                    for (const component of missingComponents) {
                        output.appendLine(`  ${component}`);
                    }

                    output.show(false);

                    void vscode.window.showErrorMessage(
                        'PascalABC.NET compiler components were not found.'
                    );
                    return;
                }

                controller = new CompilerController(
                    compilerProfile,
                    output
                );

                context.subscriptions.push(controller);
            }

            output.show(true);
            output.appendLine('');
            output.appendLine(
                `Compiling ${document.fileName} with ${compilerProfile.label}`
            );

            try {
                const response =
                    await controller.compile(document.fileName);

                publishDiagnostics(response, diagnostics);

                if (response.success) {
                    output.appendLine(
                        `Compilation succeeded: ${response.outputFile ?? ''}`
                    );

                    output.appendLine(
                        `Worker PID=${String(response.workerPid)}, ` +
                        `memory=${String(response.workingSetMB)} MB`
                    );

                    void vscode.window.setStatusBarMessage(
                        '$(check) PascalABC.NET: compilation succeeded',
                        3000
                    );

                    if (runAfterSuccess) {
                        const editorBeforeRun = vscode.window.activeTextEditor;
                        const sourceExtension = path.extname(document.fileName);
                        const reportedOutputFile = response.outputFile?.trim() ||
                            document.fileName.slice(0, -sourceExtension.length) + '.exe';
                        const outputFile = path.isAbsolute(reportedOutputFile)
                            ? reportedOutputFile
                            : path.resolve(
                                path.dirname(document.fileName),
                                reportedOutputFile
                            );

                        const workingDirectory =
                            path.dirname(document.fileName);

                        runTerminal ??= vscode.window.terminals.find(
                            terminal => terminal.name === 'PascalABC.NET'
                        );

                        let terminalCreated = false;

                        if (!runTerminal) {
                            runTerminal = vscode.window.createTerminal({
                                name: 'PascalABC.NET',
                                cwd: workingDirectory,
                                shellPath: 'powershell.exe'
                            });
                            terminalCreated = true;
                        }

                        const terminal = runTerminal;
                        terminal.show(false);

                        const runCommand = compilerProfile.target === 'net10'
                            ? `dotnet "${escapePowerShellDoubleQuoted(outputFile)}"`
                            : `& "${escapePowerShellDoubleQuoted(outputFile)}"`;
                        const commandLine =
                            'Clear-Host; ' +
                            `Set-Location -LiteralPath "${escapePowerShellDoubleQuoted(workingDirectory)}"; ` +
                            runCommand;

                        const shellIntegration =
                            await waitForShellIntegration(terminal);

                        if (!shellIntegration) {
                            activeRunExecution = undefined;
                            terminal.sendText(commandLine);
                            return;
                        }

                        if (terminalCreated) {
                            await waitForInitialShellPrompt(shellIntegration);
                        }

                        let execution: vscode.TerminalShellExecution;
                        const endSubscription =
                            vscode.window.onDidEndTerminalShellExecution(
                                event => {
                                    if (event.execution !== execution) {
                                        return;
                                    }

                                    endSubscription.dispose();

                                    if (activeRunExecution !== execution) {
                                        return;
                                    }

                                    activeRunExecution = undefined;

                                    if (editorBeforeRun) {
                                        void vscode.commands.executeCommand(
                                            'workbench.action.focusActiveEditorGroup'
                                        );
                                    }
                                }
                            );

                        activeRunExecution = undefined;
                        execution = shellIntegration.executeCommand(commandLine);
                        activeRunExecution = execution;
                    }
                } else {
                    output.appendLine(
                        `[error] ${response.message ?? 'Compilation failed'}`
                    );

                    void vscode.window.showErrorMessage(
                        'PascalABC.NET: ошибка компиляции.'
                    );

                    const responseDiagnostics = response.diagnostics ?? [];
                    const focusedSingleError =
                        responseDiagnostics.length === 1 &&
                        await focusDiagnostic(responseDiagnostics[0]);

                    if (!focusedSingleError) {
                        await vscode.commands.executeCommand(
                            'workbench.action.problems.focus'
                        );
                    }
                }
            } catch (error) {
                const message =
                    error instanceof Error
                        ? error.message
                        : String(error);

                output.appendLine(`Controller error: ${message}`);

                void vscode.window.showErrorMessage(
                    `PascalABC.NET: ${message}`
                );
            }
}

function findMissingCompilerComponents(
    profile: CompilerProfile
): string[] {
    const candidates = [
        ...profile.requiredComponents.map(component =>
            path.join(profile.runtimeDirectory, component)
        )
    ];

    return candidates.filter(candidate => !fs.existsSync(candidate));
}

async function waitForInitialShellPrompt(
    shellIntegration: vscode.TerminalShellIntegration
): Promise<void> {
    const deadline = Date.now() + 3000;

    while (!shellIntegration.cwd && Date.now() < deadline) {
        await delay(50);
    }

    // Shell integration can report cwd just before PowerShell accepts input.
    await delay(100);
}

function delay(milliseconds: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function focusDiagnostic(
    diagnostic: CompilerDiagnostic
): Promise<boolean> {
    try {
        const document = await vscode.workspace.openTextDocument(
            vscode.Uri.file(diagnostic.fileName)
        );
        const line = Math.min(
            Math.max(0, diagnostic.line - 1),
            Math.max(0, document.lineCount - 1)
        );
        const column = Math.min(
            Math.max(0, diagnostic.column - 1),
            document.lineAt(line).text.length
        );
        const position = new vscode.Position(line, column);
        const editor = await vscode.window.showTextDocument(document, {
            preview: false,
            preserveFocus: false,
            selection: new vscode.Range(position, position)
        });

        editor.selection = new vscode.Selection(position, position);
        editor.revealRange(
            new vscode.Range(position, position),
            vscode.TextEditorRevealType.InCenter
        );

        await vscode.commands.executeCommand(
            'workbench.action.focusActiveEditorGroup'
        );

        return true;
    } catch {
        return false;
    }
}

async function waitForShellIntegration(
    terminal: vscode.Terminal
): Promise<vscode.TerminalShellIntegration | undefined> {
    if (terminal.shellIntegration) {
        return terminal.shellIntegration;
    }

    return new Promise(resolve => {
        let completed = false;

        const complete = (
            shellIntegration: vscode.TerminalShellIntegration | undefined
        ): void => {
            if (completed) {
                return;
            }

            completed = true;
            clearTimeout(timer);
            subscription.dispose();
            resolve(shellIntegration);
        };

        const subscription =
            vscode.window.onDidChangeTerminalShellIntegration(event => {
                if (event.terminal === terminal) {
                    complete(event.shellIntegration);
                }
            });

        const timer = setTimeout(() => complete(undefined), 3000);

        if (terminal.shellIntegration) {
            complete(terminal.shellIntegration);
        }
    });
}

function escapePowerShellDoubleQuoted(value: string): string {
    return value
        .replace(/`/g, '``')
        .replace(/\$/g, '`$')
        .replace(/"/g, '`"');
}

function getCompilerTarget(): CompilerTarget {
    return vscode.workspace.getConfiguration('pascalabc').get<CompilerTarget>(
        'compilerTarget',
        'net-framework'
    );
}

function getCompilerTargetLabel(): string {
    return getCompilerTarget() === 'net10'
        ? '.NET 10'
        : '.NET Framework 4.7.2';
}

function updateCompilerStatus(status: vscode.StatusBarItem): void {
    status.text = `$(tools) PascalABC.NET: ${getCompilerTargetLabel()}`;
    status.tooltip = 'Select PascalABC.NET compiler target';
    if (vscode.window.activeTextEditor?.document.languageId === 'pascalabc') {
        status.show();
    } else {
        status.hide();
    }
}

function resolveCompilerProfile(
    context: vscode.ExtensionContext
): CompilerProfile {
    const configuration =
        vscode.workspace.getConfiguration('pascalabc');
    const target = getCompilerTarget();
    const configuredPath =
        configuration.get<string>('controllerPath', '').trim();

    if (target === 'net-framework') {
        const controllerPath = configuredPath !== ''
            ? path.resolve(configuredPath)
            : context.asAbsolutePath(path.join(
                'bin',
                'net-framework',
                'PABCCompilerController.exe'
            ));
        const runtimeDirectory = path.dirname(controllerPath);

        return {
            target,
            label: '.NET Framework 4.7.2',
            runtimeDirectory,
            command: controllerPath,
            args: [],
            requiredComponents: [
                path.basename(controllerPath),
                ...legacyRequiredCompilerComponents
            ]
        };
    }

    const runtimeDirectory = context.asAbsolutePath(path.join('bin', 'net10'));
    const controllerPath = path.join(
        runtimeDirectory,
        'PABCCompilerController.dll'
    );

    return {
        target,
        label: '.NET 10',
        runtimeDirectory,
        command: 'dotnet',
        args: [controllerPath],
        requiredComponents: modernRequiredCompilerComponents
    };
}

function publishDiagnostics(
    response: CompileResponse,
    collection: vscode.DiagnosticCollection
): void {
    const grouped = new Map<string, vscode.Diagnostic[]>();

    for (const item of response.diagnostics ?? []) {
        const line = Math.max(0, item.line - 1);
        const column = Math.max(0, item.column - 1);

        const position = new vscode.Position(line, column);
        const range = new vscode.Range(position, position);

        const diagnostic = new vscode.Diagnostic(
            range,
            item.message,
            toSeverity(item.severity)
        );

        diagnostic.source = 'PascalABC.NET';

        const existing = grouped.get(item.fileName) ?? [];
        existing.push(diagnostic);
        grouped.set(item.fileName, existing);
    }

    for (const [fileName, items] of grouped) {
        collection.set(vscode.Uri.file(fileName), items);
    }
}

function toSeverity(value: string): vscode.DiagnosticSeverity {
    switch (value.toLowerCase()) {
        case 'warning':
            return vscode.DiagnosticSeverity.Warning;

        case 'information':
        case 'info':
            return vscode.DiagnosticSeverity.Information;

        case 'hint':
            return vscode.DiagnosticSeverity.Hint;

        default:
            return vscode.DiagnosticSeverity.Error;
    }
}

export function deactivate(): void {
    controller?.dispose();
    controller = undefined;
}
