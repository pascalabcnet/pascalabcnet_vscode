import * as vscode from 'vscode';
import { registerNuGet } from './nuget';
import { CompilationProgress, CompilerProgressEvent } from './compilationProgress';
import {
    ChildProcessWithoutNullStreams,
    execFile,
    spawn
} from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    State,
    TransportKind
} from 'vscode-languageclient/node';
import * as fullline from './fullline';

let controller: CompilerController | undefined;
let languageClient: LanguageClient | undefined;
let runTerminal: vscode.Terminal | undefined;
let activeRunExecution: vscode.TerminalShellExecution | undefined;
let compilationInProgress = false;
let compilationGeneration = 0;
let lastPascalDocumentUri: vscode.Uri | undefined;
let languageServerOutput: vscode.LogOutputChannel | undefined;
// Per-client registrations (NuGet commands, providers, notifications) are
// disposed and re-created together with the language client; keeping them in
// context.subscriptions made every restart re-register commands, which threw
// and left the window without a language server.
let languageServerExtras: vscode.Disposable[] = [];
let fullLineOperation: Promise<unknown> = Promise.resolve();
// Set while applyFullLineState itself flips the enabled setting, so the
// configuration listener does not run a second, redundant apply cycle.
let suppressConfigApply = false;

type CompilerTarget = 'net-framework' | 'net10';

interface CompilerProfile {
    target: CompilerTarget;
    label: string;
    runtimeDirectory: string;
    command: string;
    args: string[];
    requiredComponents: readonly string[];
}

interface CompilerTargetQuickPickItem extends vscode.QuickPickItem {
    target: CompilerTarget;
}

const legacyRequiredCompilerComponents = [
    'PABCCompilerWorker.exe',
    'Compiler.dll',
    'CompilerTools.dll',
    'Errors.dll',
    'LambdaAnySynToSemConverter.dll',
    'LanguageIntegrator.dll',
    'Localization.dll',
    'NETGenerator.dll',
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
    'TreeConverter.dll',
    'Lib',
    'Lng'
] as const;

const modernRequiredCompilerComponents = [
    'PABCCompilerController.dll',
    'PABCCompilerController.deps.json',
    'PABCCompilerController.runtimeconfig.json',
    'PABCCompilerWorker.dll',
    'PABCCompilerWorker.deps.json',
    'PABCCompilerWorker.runtimeconfig.json',
    'Compiler.dll',
    'CompilerTools.dll',
    'Errors.dll',
    'NETGenerator.dll',
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
    onProgress?: (event: CompilerProgressEvent) => void;
    resolve: (response: CompileResponse) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
}

class CompilerControllerStoppedError extends Error {
    public constructor() {
        super('Compiler controller was stopped.');
        this.name = 'CompilerControllerStoppedError';
    }
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

    public async compile(
        fileName: string,
        outputDirectory: string,
        sourceFiles: { fileName: string; text: string }[]
    ): Promise<CompileResponse> {
        const progress = new CompilationProgress(this.output);
        try {
            await this.ensureStarted();
            return await this.sendRequest({
            command: 'compile',
            emitEvents: true,
            fileName,
            outputDirectory,
            sourceFiles
            }, 5 * 60 * 1000, event => progress.update(event));
        } finally {
            progress.dispose();
        }
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
        readline.createInterface({
            input: this.process.stderr,
            crlfDelay: Infinity
        }).on('line', line => {
            this.output.appendLine(line.replace(/^\[worker error\]/, '[worker]'));
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
        timeoutMs = 5 * 60 * 1000,
        onProgress?: (event: CompilerProgressEvent) => void
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
                onProgress,
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
        let response: CompileResponse & Partial<CompilerProgressEvent>;

        try {
            response = JSON.parse(line) as CompileResponse;
        } catch {
            this.output.appendLine(
                `Invalid controller output: ${line}`
            );
            return;
        }

        const pendingRequest = this.pending.get(response.id);

        if (response.event === 'compilerState' || response.event === 'compilerMessage') {
            pendingRequest?.onProgress?.(response as CompilerProgressEvent);
            return; // Events share the request ID but never complete the request.
        }

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
        this.failAllRequests(new CompilerControllerStoppedError());

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

interface SnippetDefinition {
    prefix: string | string[];
    body: string | string[];
    description?: string;
}

class PascalABCSnippetProvider implements vscode.CompletionItemProvider {
    public constructor(
        private readonly snippets: ReadonlyArray<[
            string,
            SnippetDefinition
        ]>
    ) {
    }

    public provideCompletionItems(
        document: vscode.TextDocument,
        position: vscode.Position
    ): vscode.CompletionList {
        const linePrefix = document.lineAt(position).text.slice(
            0,
            position.character
        );
        if (/\.\s*[\p{L}\w]*$/u.test(linePrefix)) {
            return new vscode.CompletionList([], true);
        }

        const wordMatch = linePrefix.match(/[\p{L}\w]+$/u);
        const typedPrefix = wordMatch?.[0].toLocaleLowerCase() ?? '';

        const items = this.snippets.flatMap(([name, definition], index) => {
            const prefixes = Array.isArray(definition.prefix)
                ? definition.prefix
                : [definition.prefix];
            const matchingPrefix = prefixes.find(prefix =>
                prefix.toLocaleLowerCase().startsWith(typedPrefix)
            );
            if (!matchingPrefix) {
                return [];
            }

            const item = new vscode.CompletionItem(
                matchingPrefix,
                vscode.CompletionItemKind.Snippet
            );
            const body = Array.isArray(definition.body)
                ? definition.body.join('\n')
                : definition.body;
            item.insertText = new vscode.SnippetString(body);
            item.detail = name;
            item.documentation = definition.description;
            item.filterText = matchingPrefix;
            item.sortText = index.toString().padStart(3, '0');

            return [item];
        });

        return new vscode.CompletionList(items, true);
    }
}

function registerSnippetProvider(
    context: vscode.ExtensionContext
): vscode.Disposable {
    const snippetsPath = context.asAbsolutePath(path.join(
        'snippets',
        'pascalabc.json'
    ));
    const snippets = JSON.parse(
        fs.readFileSync(snippetsPath, 'utf8')
    ) as Record<string, SnippetDefinition>;

    return vscode.languages.registerCompletionItemProvider(
        { language: 'pascalabc' },
        new PascalABCSnippetProvider(Object.entries(snippets)),
        '.'
    );
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
    if (process.platform === 'win32') {
        compilerStatus.command = 'pascalabc.selectCompilerTarget';
    }
    compilerStatus.name = 'PascalABC.NET Compiler';
    updateCompilerStatus(compilerStatus);
    const snippetProvider = registerSnippetProvider(context);
    context.subscriptions.push(
        output,
        diagnostics,
        compilerStatus,
        snippetProvider
    );

    startLanguageServer(context);
    // Логи установки/обновления ИИ-дополнения идут в канал Language Server.
    registerFullLineCompletion(context, getLanguageServerOutput(context));

    context.subscriptions.push(
        vscode.window.onDidCloseTerminal(terminal => {
            if (terminal === runTerminal) {
                runTerminal = undefined;
                activeRunExecution = undefined;
            }
        })
    );
    rememberPascalEditor(vscode.window.activeTextEditor);
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(editor => {
            rememberPascalEditor(editor);
            updateCompilerStatus(compilerStatus);
        })
    );

    const compileCommand = vscode.commands.registerCommand(
        'pascalabc.compileCurrentFile',
        (resource?: vscode.Uri) => compileActiveDocument(
            context,
            output,
            diagnostics,
            false,
            resource
        )
    );

    const compileAndRunCommand = vscode.commands.registerCommand(
        'pascalabc.compileAndRun',
        (resource?: vscode.Uri) => compileActiveDocument(
            context,
            output,
            diagnostics,
            true,
            resource
        )
    );

    const showOutputCommand = vscode.commands.registerCommand(
        'pascalabc.showOutput',
        () => output.show(false)
    );

    const openOutputFolderCommand = vscode.commands.registerCommand(
        'pascalabc.openOutputFolder',
        async () => {
            const outputDirectory = path.join(
                context.globalStorageUri.fsPath,
                'output'
            );
            await fs.promises.mkdir(outputDirectory, { recursive: true });
            await vscode.env.openExternal(vscode.Uri.file(outputDirectory));
        }
    );

    const restartCompilerCommand = vscode.commands.registerCommand(
        'pascalabc.restartCompiler',
        () => {
            const wasRunning = controller !== undefined;

            invalidateActiveCompilation();
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
            if (process.platform !== 'win32') {
                void vscode.window.showInformationMessage(
                    'PascalABC.NET uses the .NET 10 compiler on Linux.'
                );
                return;
            }

            const currentTarget = getCompilerTarget();
            const selected = await showCompilerTargetQuickPick(currentTarget);

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
            invalidateActiveCompilation();
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
        openOutputFolderCommand,
        restartCompilerCommand,
        selectCompilerTargetCommand,
        newFileCommand,
        openFileCommand,
        saveFileCommand
    );
}

function showCompilerTargetQuickPick(
    currentTarget: CompilerTarget
): Promise<CompilerTargetQuickPickItem | undefined> {
    const items: CompilerTargetQuickPickItem[] = process.platform === 'win32'
        ? [
        {
            label: '.NET Framework 4.7.2',
            description: 'Classic PascalABC.NET runtime',
            target: 'net-framework'
        },
        {
            label: '.NET 10',
            description: 'Modern .NET runtime',
            target: 'net10'
        }
        ]
        : [
            {
                label: '.NET 10',
                description: 'Modern cross-platform runtime',
                target: 'net10'
            }
        ];
    const quickPick = vscode.window.createQuickPick<CompilerTargetQuickPickItem>();
    quickPick.title = 'Select PascalABC.NET compiler';
    quickPick.placeholder = 'Choose a compiler target';
    quickPick.items = items;
    quickPick.activeItems = items.filter(item => item.target === currentTarget);

    return new Promise(resolve => {
        let accepted = false;

        quickPick.onDidAccept(() => {
            accepted = true;
            resolve(quickPick.selectedItems[0]);
            quickPick.hide();
        });
        quickPick.onDidHide(() => {
            if (!accepted) {
                resolve(undefined);
            }
            quickPick.dispose();
        });
        quickPick.show();
    });
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

function rememberPascalEditor(editor: vscode.TextEditor | undefined): void {
    if (editor?.document.languageId === 'pascalabc') {
        lastPascalDocumentUri = editor.document.uri;
    }
}

function resolveCompileDocument(
    resource: vscode.Uri | undefined
): vscode.TextDocument | undefined {
    const resourceDocument = resource
        ? vscode.workspace.textDocuments.find(document =>
            document.uri.toString() === resource.toString()
        )
        : undefined;

    if (resourceDocument?.languageId === 'pascalabc') {
        lastPascalDocumentUri = resourceDocument.uri;
        return resourceDocument;
    }

    const activeDocument = vscode.window.activeTextEditor?.document;

    if (activeDocument?.languageId === 'pascalabc') {
        lastPascalDocumentUri = activeDocument.uri;
        return activeDocument;
    }

    const rememberedDocument = lastPascalDocumentUri
        ? vscode.workspace.textDocuments.find(document =>
            document.uri.toString() === lastPascalDocumentUri?.toString()
        )
        : undefined;

    if (rememberedDocument?.languageId === 'pascalabc') {
        return rememberedDocument;
    }

    return vscode.window.visibleTextEditors.find(editor =>
        editor.document.languageId === 'pascalabc'
    )?.document;
}

async function compileActiveDocument(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    diagnostics: vscode.DiagnosticCollection,
    runAfterSuccess: boolean,
    resource?: vscode.Uri
): Promise<void> {
    const document = resolveCompileDocument(resource);

    if (!document) {
        void vscode.window.showErrorMessage(
            'Нет активного файла PascalABC.NET для компиляции.'
        );
        return;
    }

    if (compilationInProgress) {
        const action = await vscode.window.showWarningMessage(
            'PascalABC.NET: компиляция уже выполняется.',
            'Перезапустить компилятор'
        );

        if (action === 'Перезапустить компилятор') {
            await vscode.commands.executeCommand(
                'pascalabc.restartCompiler'
            );
        }
        return;
    }

    const generation = ++compilationGeneration;
    compilationInProgress = true;

    try {
        if (runAfterSuccess) {
            await stopActiveRun();
        }

        await performCompileActiveDocument(
            context,
            output,
            diagnostics,
            runAfterSuccess,
            document
        );
    } finally {
        if (compilationGeneration === generation) {
            compilationInProgress = false;
        }
    }
}

function invalidateActiveCompilation(): void {
    compilationGeneration++;
    compilationInProgress = false;
}

async function stopActiveRun(): Promise<void> {
    const terminal = runTerminal;

    if (!activeRunExecution || !terminal) {
        return;
    }

    activeRunExecution = undefined;
    runTerminal = undefined;

    await new Promise<void>(resolve => {
        let completed = false;
        let timeout: NodeJS.Timeout | undefined;

        const complete = (): void => {
            if (completed) {
                return;
            }

            completed = true;
            subscription.dispose();

            if (timeout) {
                clearTimeout(timeout);
            }

            resolve();
        };

        const subscription = vscode.window.onDidCloseTerminal(closedTerminal => {
            if (closedTerminal === terminal) {
                complete();
            }
        });

        timeout = setTimeout(complete, 1500);
        terminal.dispose();
    });
}

async function performCompileActiveDocument(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    diagnostics: vscode.DiagnosticCollection,
    runAfterSuccess: boolean,
    initialDocument: vscode.TextDocument
): Promise<void> {
            let document = initialDocument;

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

            const sourceFileName = document.uri.scheme === 'file'
                ? document.uri.fsPath
                : document.fileName;
            const sourceExistsOnDisk = isFileOnDisk(sourceFileName);

            if (!sourceExistsOnDisk) {
                output.appendLine(
                    `Cannot compile document URI: ${document.uri.toString()}`
                );
                void vscode.window.showErrorMessage(
                    'Можно компилировать только файл на диске.'
                );
                return;
            }

            if (path.extname(sourceFileName).toLowerCase() !== '.pas') {
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

            diagnostics.clear();

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

                const runtimeError =
                    await getCompilerRuntimeError(compilerProfile);

                if (runtimeError) {
                    output.appendLine('');
                    output.appendLine(`[error] ${runtimeError}`);
                    output.show(false);
                    void vscode.window.showErrorMessage(runtimeError);
                    return;
                }

                controller = new CompilerController(
                    compilerProfile,
                    output
                );

                context.subscriptions.push(controller);
            }

            if (!runAfterSuccess) {
                output.show(true);
            }
            output.appendLine('');
            output.appendLine(
                `Compiling ${sourceFileName} with ${compilerProfile.label}`
            );

            try {
                const outputDirectory = path.join(
                    context.globalStorageUri.fsPath,
                    'output'
                );
                await fs.promises.mkdir(outputDirectory, { recursive: true });
                const response =
                    await controller.compile(sourceFileName, outputDirectory,
                        vscode.workspace.textDocuments
                            .filter(item => !item.isClosed && item.uri.scheme === 'file' &&
                                path.extname(item.uri.fsPath).toLowerCase() === '.pas')
                            .map(item => ({ fileName: item.uri.fsPath, text: item.getText() })));

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
                        const editorBeforeRun =
                            vscode.window.visibleTextEditors.find(editor =>
                                editor.document.uri.toString() ===
                                document.uri.toString()
                            );
                        const sourceExtension = path.extname(sourceFileName);
                        const reportedOutputFile = response.outputFile?.trim() ||
                            sourceFileName.slice(0, -sourceExtension.length) + '.exe';
                        const outputFile = path.isAbsolute(reportedOutputFile)
                            ? reportedOutputFile
                            : path.resolve(
                                path.dirname(sourceFileName),
                                reportedOutputFile
                            );

                        const workingDirectory =
                            path.dirname(sourceFileName);

                        runTerminal ??= vscode.window.terminals.find(
                            terminal => terminal.name === 'PascalABC.NET'
                        );

                        let terminalCreated = false;

                        if (!runTerminal) {
                            const terminalOptions: vscode.TerminalOptions = {
                                name: 'PascalABC.NET',
                                cwd: workingDirectory
                            };

                            if (process.platform === 'win32') {
                                terminalOptions.shellPath = 'powershell.exe';
                            }

                            runTerminal = vscode.window.createTerminal(
                                terminalOptions
                            );
                            terminalCreated = true;
                        }

                        const terminal = runTerminal;
                        terminal.show(false);

                        const commandLine = process.platform === 'win32'
                            ? createPowerShellRunCommand(
                                compilerProfile,
                                workingDirectory,
                                outputFile
                            )
                            : createPosixRunCommand(
                                workingDirectory,
                                outputFile,
                                compilerProfile.command
                            );

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

                                    void vscode.commands.executeCommand(
                                        'workbench.action.terminal.scrollToBottom'
                                    );

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

                    const responseDiagnostics = response.diagnostics ?? [];
                    if (responseDiagnostics.length === 1) {
                        await focusDiagnostic(responseDiagnostics[0]);
                    }

                    await vscode.commands.executeCommand(
                        'workbench.action.problems.focus'
                    );
                }
            } catch (error) {
                if (error instanceof CompilerControllerStoppedError) {
                    output.appendLine('Compiler request cancelled.');
                    return;
                }

                const message =
                    error instanceof Error
                        ? error.message
                        : String(error);

                output.appendLine(`Controller error: ${message}`);

                if (message.includes('timed out')) {
                    controller?.dispose();
                    controller = undefined;
                }

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

function isFileOnDisk(fileName: string): boolean {
    if (!path.isAbsolute(fileName)) {
        return false;
    }

    try {
        return fs.statSync(fileName).isFile();
    } catch {
        return false;
    }
}

function resolveDotnetExecutable(): string {
    const executableName = process.platform === 'win32'
        ? 'dotnet.exe'
        : 'dotnet';
    const architecture = process.arch === 'ia32'
        ? 'X86'
        : process.arch.toUpperCase();
    const architectureRoot = process.env[`DOTNET_ROOT_${architecture}`];
    const configuredRoots = [
        architectureRoot,
        process.env.DOTNET_ROOT
    ].filter((value): value is string => Boolean(value));
    const candidates: Array<string | undefined> = [
        process.env.DOTNET_HOST_PATH,
        ...configuredRoots.map(root => path.join(root, executableName)),
        path.join(os.homedir(), '.dotnet', executableName)
    ];

    if (process.platform === 'win32') {
        candidates.push(
            process.env.ProgramFiles
                ? path.join(process.env.ProgramFiles, 'dotnet', executableName)
                : undefined,
            process.env['ProgramFiles(x86)']
                ? path.join(
                    process.env['ProgramFiles(x86)'],
                    'dotnet',
                    executableName
                )
                : undefined
        );
    } else {
        candidates.push(
            '/usr/bin/dotnet',
            '/usr/local/bin/dotnet',
            '/usr/share/dotnet/dotnet',
            '/usr/local/share/dotnet/dotnet'
        );
    }

    return candidates.find(
        (candidate): candidate is string =>
            candidate !== undefined && isFileOnDisk(candidate)
    ) ?? 'dotnet';
}

async function getCompilerRuntimeError(
    profile: CompilerProfile
): Promise<string | undefined> {
    if (profile.target !== 'net10') {
        return undefined;
    }

    const runtimeList = await new Promise<string | undefined>(resolve => {
        execFile(
            profile.command,
            ['--list-runtimes'],
            {
                encoding: 'utf8',
                timeout: 10_000,
                windowsHide: true
            },
            (error, stdout) => {
                resolve(error ? undefined : stdout);
            }
        );
    });

    if (runtimeList && /^Microsoft\.NETCore\.App\s+10\./m.test(runtimeList)) {
        return undefined;
    }

    return process.platform === 'win32'
        ? '.NET 10 runtime was not found. Install Microsoft.NETCore.App 10.x ' +
            'or select .NET Framework 4.7.2.'
        : '.NET 10 runtime was not found. Install Microsoft.NETCore.App 10.x.';
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

function createPowerShellRunCommand(
    profile: CompilerProfile,
    workingDirectory: string,
    outputFile: string
): string {
    const escapedOutputFile = escapePowerShellDoubleQuoted(outputFile);
    const runCommand = profile.target === 'net10'
        ? `& "${escapePowerShellDoubleQuoted(profile.command)}" "${escapedOutputFile}"`
        : `& "${escapedOutputFile}"`;

    return 'Clear-Host; ' +
        `Set-Location -LiteralPath "${escapePowerShellDoubleQuoted(workingDirectory)}"; ` +
        runCommand;
}

function quotePosixShell(value: string): string {
    return `'${value.split("'").join("'\"'\"'")}'`;
}

function createPosixRunCommand(
    workingDirectory: string,
    outputFile: string,
    dotnetCommand: string
): string {
    return `printf '\\033[2J\\033[3J\\033[H'; ` +
        `cd -- ${quotePosixShell(workingDirectory)}; ` +
        `${quotePosixShell(dotnetCommand)} ${quotePosixShell(outputFile)}`;
}

function getCompilerTarget(): CompilerTarget {
    if (process.platform !== 'win32') {
        return 'net10';
    }

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
    status.tooltip = process.platform === 'win32'
        ? 'Select PascalABC.NET compiler target'
        : 'PascalABC.NET uses .NET 10 on Linux and macOS';
    if (vscode.window.activeTextEditor?.document.languageId === 'pascalabc') {
        status.show();
    } else {
        status.hide();
    }
}

function resolveNet10RuntimeDirectory(context: vscode.ExtensionContext): string {
    return context.asAbsolutePath(path.join('bin', 'net10'));
}

function resolveCompilerProfile(
    context: vscode.ExtensionContext
): CompilerProfile {
    const target = getCompilerTarget();

    if (target === 'net-framework') {
        const controllerPath = context.asAbsolutePath(path.join(
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

    const runtimeDirectory = resolveNet10RuntimeDirectory(context);
    const controllerPath = path.join(
        runtimeDirectory,
        'PABCCompilerController.dll'
    );

    return {
        target,
        label: '.NET 10',
        runtimeDirectory,
        command: resolveDotnetExecutable(),
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

function sortMemberCompletions(
    result: vscode.CompletionItem[] | vscode.CompletionList | undefined | null
): vscode.CompletionItem[] | vscode.CompletionList | undefined | null {
    const items = Array.isArray(result) ? result : result?.items;
    if (!items) {
        return result;
    }

    const isProperty = (item: vscode.CompletionItem): boolean =>
        item.kind === vscode.CompletionItemKind.Property ||
        item.kind === vscode.CompletionItemKind.Field;
    const isMethod = (item: vscode.CompletionItem): boolean =>
        item.kind === vscode.CompletionItemKind.Method ||
        item.kind === vscode.CompletionItemKind.Constructor;

    if (!items.some(isProperty) || !items.some(isMethod)) {
        return result;
    }

    for (const item of items) {
        const group = isProperty(item) ? '0' : isMethod(item) ? '1' : '2';
        const label = typeof item.label === 'string'
            ? item.label
            : item.label.label;
        item.sortText = `${group}_${item.sortText ?? label}`;
    }

    return result;
}

type NavigationResult = vscode.Definition | vscode.LocationLink[] | null | undefined;
interface MetadataDocument {
    Title: string;
    Text: string;
}

function metadataFileName(document: MetadataDocument): string {
    // The title can include a member (System.Object.GetType); the view shows
    // the declaring type. Locate that type in the rendered Pascal declaration.
    const declaration = /^\s*([\p{L}_&][\p{L}\p{N}_&]*)(?:<[^\r\n=;]+>)?\s*=\s*(?:(?:sealed|abstract|partial)\s+)*(?:class|interface|record)\b/imu.exec(document.Text);
    let title = document.Title;
    if (declaration) {
        const name = declaration[1].replace(/^&/, '');
        const type = new RegExp(`(?:^|[.+])${name}(?:\x60\\d+)?(?=[.+\\[]|$)`).exec(title);
        title = type ? title.slice(0, type.index + type[0].length) : name;
    }
    const safeName = title.replace(/`\d+/g, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .slice(0, 120).replace(/[. ]+$/, '');
    return `${safeName || 'Metadata'}.pas`;
}

async function selectNavigationIdentifier(
    result: NavigationResult,
    token: vscode.CancellationToken,
    nameMetadata: (uri: vscode.Uri, token: vscode.CancellationToken) => Promise<vscode.Uri>
): Promise<NavigationResult> {
    if (!result) {
        return result;
    }

    const selectName = async (location: vscode.Location | vscode.LocationLink) => {
        const link = 'targetUri' in location;
        const uri = link ? location.targetUri : location.uri;
        const selection = link ? location.targetSelectionRange ?? location.targetRange : location.range;
        if (uri.scheme === 'pascalabc-metadata' && !token.isCancellationRequested) {
            const namedUri = await nameMetadata(uri, token);
            return link ? { ...location, targetUri: namedUri } : new vscode.Location(namedUri, location.range);
        }
        // Legacy DOM locations point at column zero of a routine header.
        // Select its identifier so a subsequent F12/Ctrl+F12 resolves the symbol,
        // rather than the procedure/function keyword. Keep all semantic targets.
        if (token.isCancellationRequested || uri.scheme !== 'file' ||
            !selection.isEmpty || selection.start.character !== 0) {
            return location;
        }
        try {
            const document = await vscode.workspace.openTextDocument(uri);
            if (token.isCancellationRequested || selection.start.line >= document.lineCount) {
                return location;
            }
            const line = document.lineAt(selection.start.line).text;
            const header = /^\s*(?:(?:class|static)\s+)*(?:procedure|function|constructor|destructor)\s+(?:[\p{L}\p{N}_&]+\.)*([\p{L}_&][\p{L}\p{N}_&]*)/iu.exec(line);
            if (!header) {
                return location;
            }
            const start = header[0].length - header[1].length;
            const range = new vscode.Range(selection.start.line, start,
                selection.start.line, start + header[1].length);
            return link
                ? { ...location, targetSelectionRange: range,
                    targetRange: location.targetRange.union(range) }
                : new vscode.Location(uri, range);
        } catch {
            // Navigation can target sources that are no longer on disk.
            return location;
        }
    };
    if (!Array.isArray(result)) {
        return await selectName(result) as vscode.Location;
    }
    return await Promise.all(result.map(selectName)) as vscode.Location[] | vscode.LocationLink[];
}

function getLanguageServerOutput(context: vscode.ExtensionContext): vscode.LogOutputChannel {
    const existing = languageServerOutput;
    if (existing) {
        return existing;
    }
    const output = vscode.window.createOutputChannel(
        'PascalABC.NET Language Server',
        { log: true }
    );
    context.subscriptions.push(output);
    languageServerOutput = output;
    return output;
}

// The language client logs every server process exit as an error — including
// the planned stop() when we restart the server. Exit code 0 is by definition
// our own graceful shutdown (a crash cannot exit 0), so that single line is
// filtered out to avoid a false "the server fell" alarm; other codes and
// signals stay visible.
class FilteredServerOutput implements vscode.OutputChannel {
    public constructor(private readonly channel: vscode.OutputChannel) {
    }

    public get name(): string {
        return this.channel.name;
    }

    public append(value: string): void {
        if (!value.includes('Server process exited with code 0')) {
            this.channel.append(value);
        }
    }

    public appendLine(value: string): void {
        if (!value.includes('Server process exited with code 0')) {
            this.channel.appendLine(value);
        }
    }

    public replace(value: string): void {
        if (!value.includes('Server process exited with code 0')) {
            this.channel.replace(value);
        }
    }

    public clear(): void {
        this.channel.clear();
    }

    public show(
        columnOrPreserveFocus?: vscode.ViewColumn | boolean,
        preserveFocus?: boolean
    ): void {
        (this.channel.show as (a?: unknown, b?: boolean) => void)(
            columnOrPreserveFocus,
            preserveFocus);
    }

    public hide(): void {
        this.channel.hide();
    }

    public dispose(): void {
        this.channel.dispose();
    }
}

function startLanguageServer(context: vscode.ExtensionContext): void {
    const output = getLanguageServerOutput(context);
    for (const disposable of languageServerExtras) {
        disposable.dispose();
    }
    languageServerExtras = [];

    let serverPath: string;
    try {
        serverPath = path.join(
            resolveNet10RuntimeDirectory(context),
            'PascalABCNet.LanguageServer.dll'
        );
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.error(message);
        void vscode.window.showWarningMessage(message);
        return;
    }

    if (!fs.existsSync(serverPath)) {
        const message =
            'PascalABC.NET IntelliSense server was not found. ' +
            'Compilation and Run remain available.';
        output.error(`${message} Expected path: ${serverPath}`);
        void vscode.window.showWarningMessage(message);
        return;
    }

    const dotnetCommand = resolveDotnetExecutable();
    const metadataDocuments = new Map<string, MetadataDocument>();
    const getMetadata = async (uri: vscode.Uri, token: vscode.CancellationToken) => {
        // The first path segment remains the server's full content hash;
        // the final segment is only a human-readable editor tab name.
        const hash = uri.path.split('/')[1];
        if (!/^[A-Fa-f0-9]{64}$/.test(hash || '')) {
            throw new Error('Invalid PascalABC.NET metadata URI.');
        }
        if (!client.isRunning()) {
            throw new Error('PascalABC.NET Language Server is not running.');
        }
        const cached = metadataDocuments.get(hash);
        if (cached) {
            return { hash, document: cached };
        }
        const document = await client.sendRequest<MetadataDocument | null>(
            'pascalabc/metadata', { uri: `pascalabc-metadata:///${hash}` }, token
        );
        if (!document || typeof document.Text !== 'string' || typeof document.Title !== 'string') {
            throw new Error('Metadata is no longer available. Repeat Go to Definition from the source file.');
        }
        if (metadataDocuments.size >= 32) {
            metadataDocuments.delete(metadataDocuments.keys().next().value!);
        }
        metadataDocuments.set(hash, document);
        return { hash, document };
    };
    const nameMetadata = async (uri: vscode.Uri, token: vscode.CancellationToken) => {
        const { hash, document } = await getMetadata(uri, token);
        return uri.with({ path: `/${hash}/${metadataFileName(document)}` });
    };

    output.info(
        `Starting Language Server on ${process.platform}/${process.arch}: ` +
        `${dotnetCommand} ${serverPath}`
    );

    // The full line completion plugin lives in the persistent install
    // directory (survives extension updates), not in bin/net10; the server
    // picks it up through --plugins-dir when the feature is on.
    const fullLineInstallDir = fullline.getInstallDir();
    const fullLineActive = fullline.getFullLineSettings().enabled &&
        fullline.isInstalled(fullLineInstallDir);
    const serverArgs = [
        serverPath,
        '--stdio',
        '--documentation-language',
        'ru'
    ];
    if (fullLineActive) {
        serverArgs.push('--plugins-dir', fullline.getPluginsDir(fullLineInstallDir));
    }
    const serverOptions: ServerOptions = {
        command: dotnetCommand,
        args: serverArgs,
        transport: TransportKind.stdio,
        options: {
            cwd: path.dirname(serverPath),
            detached: false,
            env: {
                ...process.env,
                [fullline.DIR_ENV_VARIABLE]: fullLineInstallDir
            }
        }
    };
    const clientOptions: LanguageClientOptions = {
        initializationOptions: { manualNuGetRestore: true },
        documentSelector: [{ language: 'pascalabc' }],
        outputChannel: new FilteredServerOutput(output),
        diagnosticCollectionName: 'pascalabc-language-server',
        middleware: {
            provideDefinition: async (document, position, token, next) =>
                selectNavigationIdentifier(await next(document, position, token), token, nameMetadata),
            provideImplementation: async (document, position, token, next) =>
                selectNavigationIdentifier(await next(document, position, token), token, nameMetadata),
            // Generated CLR declarations are read-only views, not Pascal sources
            // to analyse or add to the server's open-document dependency graph.
            didOpen: async (document, next) => {
                if (document.uri.scheme !== 'pascalabc-metadata') {
                    await next(document);
                }
            },
            didChange: async (event, next) => {
                if (event.document.uri.scheme !== 'pascalabc-metadata') {
                    await next(event);
                }
            },
            didClose: async (document, next) => {
                if (document.uri.scheme !== 'pascalabc-metadata') {
                    await next(document);
                }
            },
            provideCompletionItem: async (
                document,
                position,
                completionContext,
                token,
                next
            ) => sortMemberCompletions(await next(
                document,
                position,
                completionContext,
                token
            ))
        }
    };
    const client = new LanguageClient(
        'pascalabcLanguageServer',
        'PascalABC.NET Language Server',
        serverOptions,
        clientOptions
    );
    languageServerExtras.push(registerNuGet(client));

    // Full line completion: forwarded to the language server, whose plugins
    // provide the suggestion text (pascalabc/inlineCompletion request).
    languageServerExtras.push(
        vscode.languages.registerInlineCompletionItemProvider(
            { language: 'pascalabc' },
            {
                async provideInlineCompletionItems(
                    document: vscode.TextDocument,
                    position: vscode.Position,
                    _context: vscode.InlineCompletionContext,
                    token: vscode.CancellationToken
                ) {
                    if (!fullline.getFullLineSettings().enabled) {
                        return { items: [] };
                    }
                    if (!client.isRunning()) {
                        return { items: [] };
                    }
                    try {
                        const result = await client.sendRequest<{
                            items?: { insertText?: string }[];
                        }>('pascalabc/inlineCompletion', {
                            textDocument: { uri: document.uri.toString() },
                            position: { line: position.line, character: position.character }
                        }, token);
                        return {
                            items: (result?.items ?? [])
                                .map((item: { insertText?: string }) => item.insertText)
                                .filter((text): text is string => typeof text === 'string' && text.length > 0)
                                .map((text: string) => new vscode.InlineCompletionItem(text))
                        };
                    } catch (error) {
                        output.error(`[fullline] inline completion request failed: ${String(error)}`);
                        return { items: [] };
                    }
                }
            }
        )
    );

    languageServerExtras.push(
        vscode.workspace.registerTextDocumentContentProvider('pascalabc-metadata', {
            provideTextDocumentContent: async (uri, token) => {
                const { document } = await getMetadata(uri, token);
                return document.Text;
            }
        }),
        vscode.workspace.onDidOpenTextDocument(document => {
            if (document.uri.scheme === 'pascalabc-metadata' && document.languageId !== 'pascalabc') {
                void vscode.languages.setTextDocumentLanguage(document, 'pascalabc').then(
                    undefined, error => output.error(`Cannot highlight metadata: ${String(error)}`)
                );
            }
        })
    );

    languageServerExtras.push(client.onDidChangeState(event => {
        if (event.newState === State.Stopped) {
            metadataDocuments.clear();
        }
        output.info(
            `Language Server state: ${State[event.oldState]} -> ` +
            `${State[event.newState]}`
        );
    }));

    languageClient = client;
    void client.start().then(() => {
        output.info('Language Server client started.');
    }).catch((error: unknown) => {
        if (languageClient === client) {
            languageClient = undefined;
        }

        const details = error instanceof Error
            ? error.message
            : String(error);
        output.error(`Language server failed to start: ${details}`);
        void vscode.window.showWarningMessage(
            'PascalABC.NET IntelliSense could not be started. ' +
            'Compilation and Run remain available.'
        );
    });
}

// ---- AI full-line completion lifecycle ------------------------------------

function runFullLineOperation<T>(operation: () => Promise<T>): Promise<T> {
    // Serializes lifecycle operations (install/update/remove/restart) so a
    // checkbox flip and a palette command can never run setup concurrently.
    const result = fullLineOperation.then(operation, operation);
    fullLineOperation = result.then(() => undefined, () => undefined);
    return result;
}

async function setFullLineEnabled(enabled: boolean): Promise<void> {
    await vscode.workspace.getConfiguration('pascalabc').update(
        'fullLineCompletion.enabled',
        enabled,
        vscode.ConfigurationTarget.Global
    );
}

async function stopLanguageServer(context: vscode.ExtensionContext): Promise<void> {
    const client = languageClient;
    languageClient = undefined;
    if (client?.needsStop()) {
        try {
            await client.stop();
        } catch (error) {
            getLanguageServerOutput(context).error(`Language server stop failed: ${String(error)}`);
        }
    }
}

async function restartLanguageServer(context: vscode.ExtensionContext): Promise<void> {
    await stopLanguageServer(context);
    startLanguageServer(context);
}

function registerFullLineCompletion(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel
): void {
    const applyState = (options: { install?: boolean; enable?: boolean } = {}) =>
        runFullLineOperation(() => applyFullLineState(context, output, options));

    context.subscriptions.push(
        vscode.commands.registerCommand('pascalabc.fullLineCompletion.toggle', async () => {
            await setFullLineEnabled(!fullline.getFullLineSettings().enabled);
        }),
        // «Установить компоненты» всегда ведёт через установку/переустановку
        // (с подтверждением) и включает фичу — какова бы ни была галочка.
        vscode.commands.registerCommand('pascalabc.fullLineCompletion.install', () =>
            applyState({ install: true, enable: true })),
        vscode.commands.registerCommand('pascalabc.fullLineCompletion.update', () =>
            applyState({ install: true, enable: true })),
        vscode.commands.registerCommand('pascalabc.fullLineCompletion.remove', () =>
            runFullLineOperation(() => removeFullLineComponents(context, output))),
        vscode.commands.registerCommand('pascalabc.fullLineCompletion.restartServer', () =>
            runFullLineOperation(() => restartModelServer(context, output))),
        vscode.commands.registerCommand('pascalabc.fullLineCompletion.status', () =>
            showFullLineStatus(output)),
        // The setting is the single source of truth: the checkbox and the
        // palette commands both write it, and side effects happen only here.
        vscode.workspace.onDidChangeConfiguration(event => {
            if (!event.affectsConfiguration('pascalabc.fullLineCompletion.enabled')) {
                return;
            }
            if (suppressConfigApply) {
                return;
            }
            void applyState();
        })
    );

    void runFullLineOperation(() => checkFullLineOnStartup(context, output));
}

async function applyFullLineState(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    options: { install?: boolean; enable?: boolean }
): Promise<void> {
    if (options.enable && !fullline.getFullLineSettings().enabled) {
        // «Установить/обновить» включает фичу сама; слушатель настройки на этот
        // момент не должен запускать собственный цикл применения.
        suppressConfigApply = true;
        try {
            await setFullLineEnabled(true);
        } finally {
            suppressConfigApply = false;
        }
    }
    const settings = fullline.getFullLineSettings();
    const installDir = fullline.getInstallDir();

    if (!settings.enabled) {
        output.appendLine('AI full-line completion is disabled.');
        if (languageClient?.isRunning()) {
            // Dropping --plugins-dir unloads the plugin; its llama-server dies
            // with the old language server process.
            await restartLanguageServer(context);
        }
        return;
    }

    let installed = fullline.isInstalled(installDir);
    if (!installed || options.install) {
        const proceed = await confirmFullLineInstall(installed);
        if (!proceed) {
            if (!installed) {
                await setFullLineEnabled(false);
                void vscode.window.showInformationMessage(
                    'ИИ-дополнение строк не установлено. Повторить: палитра команд → ' +
                    '«ИИ-дополнение — включить/выключить» или галочка в настройках.');
            }
            return;
        }
        // Setup переизвлекает файлы llama.cpp и перекладывает dll — оба заняты
        // работающим сервером и его плагином, сначала остановим их.
        await stopLanguageServer(context);
        await fullline.stopLlamaServer(installDir);
        installed = await installFullLineComponents(context, output);
        if (!installed) {
            startLanguageServer(context);
            return;
        }
    } else {
        try {
            // Extension updates replace the VSIX folder; keep the deployed dll
            // in sync with the bundled one.
            fullline.deployPluginDll(context, installDir);
        } catch (error) {
            output.appendLine(`Plugin redeploy skipped: ${String(error)}`);
        }
    }

    await restartLanguageServer(context);
    trackModelWarmup(installDir, output);
}

// Модальные диалоги показывают собственную кнопку отмены в языке интерфейса
// VS Code — подписи наших кнопок и тексты подбираем под тот же язык, чтобы
// русская кнопка не стояла рядом с английским Cancel.
function isRussianUi(): boolean {
    return vscode.env.language.toLowerCase().startsWith('ru');
}

async function confirmFullLineInstall(alreadyInstalled: boolean): Promise<boolean> {
    const russian = isRussianUi();
    const acceptLabel = alreadyInstalled
        ? (russian ? 'Переустановить' : 'Reinstall')
        : (russian ? 'Установить' : 'Install');
    const message = alreadyInstalled
        ? (russian
            ? 'Переустановить компоненты ИИ-дополнения строк (llama.cpp и модель)?'
            : 'Reinstall the AI full-line completion components (llama.cpp and the model)?')
        : (russian
            ? 'ИИ-дополнение строк требует установки компонентов: llama.cpp и модель ИИ ' +
                '(скачивание может занять несколько гигабайт). Установить?'
            : 'AI full-line completion needs its components installed: llama.cpp and the AI ' +
                'model (the download may take several gigabytes). Install?');
    // Модальное окно: обычная панель уведомлений может закрыться незамеченной,
    // и тогда установка молча не запустится. Кнопку «Отмена» не добавляем —
    // модальный диалог VS Code показывает собственную (и крестик).
    const action = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        acceptLabel);
    return action === acceptLabel;
}


async function installFullLineComponents(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel
): Promise<boolean> {
    const installDir = fullline.getInstallDir();
    const settings = fullline.getFullLineSettings();
    // Источник модели закреплён за релизом расширения (см. fullline.ts) —
    // отдельной настройки для пользователя нет.
    const modelUrl = fullline.resolveModelUrl();

    const dotnet = resolveDotnetExecutable();
    try {
        await vscode.window.withProgress(
            {
                location: vscode.ProgressLocation.Notification,
                title: 'Установка ИИ-дополнения строк (llama.cpp и модель)',
                cancellable: true
            },
            async (progress, token) => {
                progress.report({ message: 'Развёртывание плагина LSP...' });
                fullline.deployPluginDll(context, installDir);
                let stageMessage = 'Установка компонентов';
                await fullline.runSetup(
                    context,
                    dotnet,
                    installDir,
                    {
                        device: settings.device,
                        modelUrl,
                        modelRevision: fullline.RECOMMENDED_MODEL_REVISION
                    },
                    event => {
                        if (event.event === 'stage' && event.message) {
                            stageMessage = event.message;
                            progress.report({ message: event.message });
                        } else if (event.event === 'progress') {
                            const receivedMb = Math.floor((event.received ?? 0) / (1 << 20));
                            const totalMb = event.total
                                ? Math.floor(event.total / (1 << 20))
                                : undefined;
                            progress.report({
                                message: totalMb
                                    ? `${stageMessage}: ${receivedMb} / ${totalMb} МБ`
                                    : `${stageMessage}: ${receivedMb} МБ`
                            });
                        }
                    },
                    output,
                    token);
            });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`Full line completion setup failed: ${message}`);
        output.show(true);
        void vscode.window.showErrorMessage(
            `Не удалось установить ИИ-дополнение строк: ${message} ` +
            'Повторить: палитра команд → «ИИ-дополнение — установить компоненты».');
        return false;
    }

    void vscode.window.showInformationMessage('ИИ-дополнение строк установлено.');
    return true;
}

async function removeFullLineComponents(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel
): Promise<void> {
    const installDir = fullline.getInstallDir();
    if (!fullline.isInstalled(installDir)) {
        void vscode.window.showInformationMessage('Компоненты ИИ-дополнения не установлены.');
        return;
    }
    const russian = isRussianUi();
    const removeLabel = russian ? 'Удалить' : 'Remove';
    const action = await vscode.window.showWarningMessage(
        russian
            ? 'Удалить llama.cpp и модель ИИ с диска? Каталог общий для всех хостов PascalABC.NET.'
            : 'Remove llama.cpp and the AI model from disk? The directory is shared by all ' +
                'PascalABC.NET hosts.',
        { modal: true },
        removeLabel);
    if (action !== removeLabel) {
        return;
    }
    output.appendLine(`Removing full line completion runtime: ${installDir}`);
    // Сначала останавливаем LSP-сервер: он держит dll плагина загруженной, а его
    // плагин — процесс llama-server; без остановки удаление падает с EPERM.
    await stopLanguageServer(context);
    try {
        await fullline.removeComponents(installDir);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`Removing failed: ${message}`);
        void vscode.window.showErrorMessage(
            `Не удалось удалить компоненты: ${message} ` +
            'Повторить: палитра команд → «ИИ-дополнение — удалить компоненты».');
        startLanguageServer(context);
        return;
    }
    startLanguageServer(context);
    void vscode.window.showInformationMessage('Компоненты ИИ-дополнения удалены.');
}

async function restartModelServer(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel
): Promise<void> {
    const installDir = fullline.getInstallDir();
    await fullline.stopLlamaServer(installDir);
    await restartLanguageServer(context);
    trackModelWarmup(installDir, output);
    void vscode.window.showInformationMessage('Сервер моделей перезапущен.');
}

function trackModelWarmup(installDir: string, output: vscode.OutputChannel): void {
    if (process.env[fullline.URL_ENV_VARIABLE]) {
        // An external model server was supplied — there is nothing to warm up.
        return;
    }
    const ready = fullline.waitForModelReady(installDir);
    void vscode.window.setStatusBarMessage(
        '$(loading~spin) ИИ-модель загружается...',
        ready.then(warm => {
            if (warm) {
                void vscode.window.setStatusBarMessage('$(check) ИИ-модель готова', 5000);
            } else {
                output.appendLine('The model server did not become ready in time.');
                void vscode.window.setStatusBarMessage(
                    '$(warning) ИИ-модель не загрузилась', 8000);
            }
        }, () => {
            // The spinner must clear even if tracking failed.
            output.appendLine('Model warm-up tracking failed.');
            void vscode.window.setStatusBarMessage(
                '$(warning) Не удалось определить готовность модели', 8000);
        }));
}

async function checkFullLineOnStartup(
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel
): Promise<void> {
    const settings = fullline.getFullLineSettings();
    if (!settings.enabled) {
        return;
    }
    const installDir = fullline.getInstallDir();

    if (!fullline.isInstalled(installDir)) {
        // «Включено, но не установлено» — доводим до разрешения тем же модальным
        // диалогом установки, что и при включении галочки: окно не должно
        // исчезать незамеченным (обычное уведомление легко пропустить).
        await applyFullLineState(context, output, {});
        return;
    }

    try {
        // Cheap local consistency check; also refreshes the dll after updates.
        fullline.deployPluginDll(context, installDir);
    } catch (error) {
        output.appendLine(`Plugin redeploy skipped: ${String(error)}`);
    }

    // Model version check against the recommended revision (cheap, local).
    const config = fullline.readSetupConfig(installDir);
    const recommendedUrl = fullline.resolveModelUrl();
    if (config?.modelUrl && config.modelUrl !== recommendedUrl) {
        const action = await vscode.window.showInformationMessage(
            'ИИ-модель устарела: вышла новая версия модели.',
            'Обновить',
            'Позже');
        if (action === 'Обновить') {
            await runFullLineOperation(() => applyFullLineState(context, output, { install: true }));
        }
    }

    trackModelWarmup(installDir, output);
}

function showFullLineStatus(output: vscode.OutputChannel): void {
    const installDir = fullline.getInstallDir();
    const settings = fullline.getFullLineSettings();
    const config = fullline.readSetupConfig(installDir);
    const state = fullline.readServerState(installDir);
    output.appendLine('');
    output.appendLine('=== Full line completion status ===');
    output.appendLine(`Enabled: ${settings.enabled}`);
    output.appendLine(`Install directory: ${installDir}`);
    output.appendLine(`Installed: ${fullline.isInstalled(installDir)}`);
    output.appendLine(`llama.cpp: ${config?.llamaTag ?? 'n/a'} (${config?.deviceClass ?? 'n/a'})`);
    output.appendLine(`Model file: ${config?.modelPath ?? 'n/a'}`);
    output.appendLine(
        `Model source: ${config?.modelUrl ?? 'n/a'}` +
        (config?.modelRevision ? ` @ ${config.modelRevision}` : ''));
    output.appendLine(`Model sha256: ${config?.modelSha256 ?? 'n/a'}`);
    output.appendLine(
        `llama-server: ${state ? `pid ${state.pid}, port ${state.port}` : 'not running'}`);
    output.show(true);
    void vscode.window.showInformationMessage(
        'Статус ИИ-дополнения — в канале вывода PascalABC.NET.');
}

export async function deactivate(): Promise<void> {
    controller?.dispose();
    controller = undefined;

    const client = languageClient;
    languageClient = undefined;
    if (client?.needsStop()) {
        await client.stop();
    }
}
