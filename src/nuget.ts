import * as vscode from 'vscode';
import { LanguageClient, State } from 'vscode-languageclient/node';

interface PackageSuggestion { Id: string; Version: string; Description?: string; }
interface RestoreResult { Success: boolean; Message?: string; }
interface RestoreProgress { operationId: string; stage: string; packageId: string; installedCount: number; cancelled: boolean; }

export function registerNuGet(context: vscode.ExtensionContext, client: LanguageClient): void {
    const output = vscode.window.createOutputChannel('PascalABC.NET NuGet');
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 20);
    status.text = '$(cloud-download) NuGet: Восстановить';
    status.command = 'pascalabc.nugetRestore';
    status.tooltip = 'Восстановить пакеты для текущего файла PascalABC.NET';
    const required = new Set<string>();
    let restoring = false;
    let report: vscode.Progress<{ message?: string }> | undefined;
    const updateStatus = () => {
        const uri = vscode.window.activeTextEditor?.document.uri.toString();
        if (uri && required.has(uri)) { status.show(); } else { status.hide(); }
    };
    const activeDocument = () => {
        const document = vscode.window.activeTextEditor?.document;
        if (!document || document.languageId !== 'pascalabc' || document.uri.scheme !== 'file') {
            throw new Error('Open a saved PascalABC.NET source file to use NuGet.');
        }
        if (!client.isRunning()) { throw new Error('PascalABC.NET Language Server is not running.'); }
        return document;
    };
    const command = (name: string, action: () => Promise<void>) => vscode.commands.registerCommand(name, async () => {
        try { await action(); } catch (error) {
            if (error instanceof vscode.CancellationError || (error as {code?: number})?.code === -32800) { return; }
            const message = error instanceof Error ? error.message : String(error);
            output.appendLine(message);
            void vscode.window.showErrorMessage(`NuGet: ${message}`);
        }
    });
    async function discover<T>(method: string, params: object): Promise<T> {
        return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'NuGet', cancellable: true },
            (_, token) => client.sendRequest<T>(method, params, token));
    }
    async function selectVersion(document: vscode.TextDocument, packageId: string, fromSearch = false): Promise<void> {
        if (!/^[A-Za-z0-9_.-]+$/.test(packageId)) { throw new Error('Invalid NuGet package ID.'); }
        const versions = await discover<string[]>('pascalabc/nugetPackageVersions', {uri: document.uri.toString(), packageId, prefix: ''});
        if (!versions.length) { void vscode.window.showInformationMessage('NuGet: версии пакета не найдены.'); return; }
        const version = await vscode.window.showQuickPick(versions, {
            title: `NuGet — ${fromSearch ? 'шаг 3 из 3' : 'шаг 2 из 2'}: выберите версию ${packageId}`,
            placeHolder: 'Теперь выберите версию (например, 13.0.3) и нажмите Enter'
        });
        if (!version) { return; }
        if (!/^[A-Za-z0-9.+-]+$/.test(version)) { throw new Error('Invalid NuGet version.'); }
        const directive = `{$package ${packageId} ${version}}`;
        const existing = /^\s*\{\$package\s+([^\s}]+)[^}]*\}/gim;
        let match: RegExpExecArray | null;
        let range: vscode.Range | undefined;
        while ((match = existing.exec(document.getText()))) {
            if (match[1].toLowerCase() === packageId.toLowerCase()) {
                range = new vscode.Range(document.positionAt(match.index), document.positionAt(match.index + match[0].length));
                break;
            }
        }
        const edit = new vscode.WorkspaceEdit();
        if (range) { edit.replace(document.uri, range, directive); }
        else { edit.insert(document.uri, new vscode.Position(0, 0), directive + (document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n')); }
        if (!await vscode.workspace.applyEdit(edit)) { throw new Error('Could not add the package directive.'); }
        await vscode.window.showTextDocument(document);
    }
    context.subscriptions.push(output, status,
        client.onDidChangeState(event => {
            if (event.newState === State.Stopped) { required.clear(); status.hide(); }
        }),
        vscode.window.onDidChangeActiveTextEditor(updateStatus),
        vscode.workspace.onDidCloseTextDocument(document => { required.delete(document.uri.toString()); updateStatus(); }),
        client.onNotification('pascalabc/nugetRestoreRequired', (value: {uri: string; required: boolean}) => {
            const uri = vscode.Uri.parse(value.uri).toString();
            if (value.required) { required.add(uri); } else { required.delete(uri); }
            updateStatus();
        }),
        client.onNotification('pascalabc/nugetRestoreProgress', (value: RestoreProgress) => {
            if (value.stage === 'heartbeat') { return; }
            const stages: Record<string, string> = {begin: 'Начало восстановления', installed: 'Установлен пакет', end: 'Завершено'};
            const message = `${stages[value.stage] || value.stage}: ${value.packageId || ''} (установлено: ${value.installedCount})${value.cancelled ? ' — отменено' : ''}`;
            output.appendLine(message);
            report?.report({message});
        }),
        command('pascalabc.nugetSearch', async () => {
            const document = activeDocument();
            const prefix = await vscode.window.showInputBox({
                title: 'NuGet — шаг 1 из 3: поиск пакета',
                prompt: 'Введите название пакета, например Newtonsoft.Json. Версия выбирается позже.',
                placeHolder: 'Название пакета, не номер версии'
            });
            if (!prefix?.trim()) { return; }
            const packages = await discover<PackageSuggestion[]>('pascalabc/searchNuGetPackages', {uri: document.uri.toString(), prefix: prefix.trim()});
            if (!packages.length) { void vscode.window.showInformationMessage('NuGet: пакеты не найдены.'); return; }
            const selected = await vscode.window.showQuickPick(packages.map(item => ({label: item.Id, detail: item.Description, packageId: item.Id})), {
                title: 'NuGet — шаг 2 из 3: выберите ПАКЕТ, затем перейдём к версии',
                placeHolder: 'Выберите название пакета стрелками и нажмите Enter. Номер версии здесь вводить не нужно.'
            });
            if (selected) { await selectVersion(document, selected.packageId, true); }
        }),
        command('pascalabc.nugetVersions', async () => {
            const document = activeDocument();
            const id = await vscode.window.showInputBox({title: 'NuGet — шаг 1 из 2: название пакета', prompt: 'Введите точное название пакета (например, Newtonsoft.Json). Далее выберем версию.'});
            if (id?.trim()) { await selectVersion(document, id.trim()); }
        }),
        command('pascalabc.nugetRestore', async () => {
            const document = activeDocument();
            if (restoring) { void vscode.window.showInformationMessage('Восстановление пакетов NuGet уже выполняется.'); return; }
            restoring = true;
            try {
                await vscode.window.withProgress({location: vscode.ProgressLocation.Notification, title: 'NuGet: восстановление пакетов', cancellable: true}, async (progress, token) => {
                    report = progress;
                    const cancel = token.onCancellationRequested(() => {
                        void client.sendRequest('pascalabc/cancelNuGetRestore').catch(error => output.appendLine(String(error)));
                    });
                    try {
                        const result = await client.sendRequest<RestoreResult>('pascalabc/restoreNuGetPackages', {uri: document.uri.toString()}, token);
                        if (token.isCancellationRequested) { return; }
                        if (!result.Success) { throw new Error(result.Message || 'Package restore did not complete.'); }
                        required.delete(document.uri.toString()); updateStatus();
                        void vscode.window.showInformationMessage('Пакеты NuGet восстановлены.');
                    } finally { cancel.dispose(); report = undefined; }
                });
            } finally { restoring = false; }
        })
    );
}
