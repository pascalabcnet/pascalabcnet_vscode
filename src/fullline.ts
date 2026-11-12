import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';

// Lifecycle of the AI full-line completion components. Everything installs
// OUTSIDE the extension folder (%LOCALAPPDATA%\PascalABC.NET\llama.cpp), so
// extension updates never wipe it. The LSP plugin is loaded through
// --plugins-dir <installDir>/LspPlugins; the plugin itself spawns llama-server
// from fullline-setup.json and writes llama-server-state.json for hosts.

export interface FullLineSetupConfig {
    schemaVersion?: number;
    createdAt?: string;
    toolVersion?: string;
    os?: string;
    arch?: string;
    deviceClass?: string;
    deviceName?: string | null;
    llamaTag?: string;
    asset?: string;
    installDir?: string;
    serverPath?: string;
    modelPath?: string | null;
    modelUrl?: string | null;
    modelRevision?: string | null;
    modelSizeBytes?: number | null;
    modelSha256?: string | null;
    serverArgs?: string[];
}

export interface LlamaServerState {
    pid: number;
    port: number;
    startedAtUtc?: string;
    serverPath?: string | null;
}

export interface SetupProgress {
    event: 'stage' | 'progress' | 'done';
    stage?: string;
    message?: string;
    received?: number;
    total?: number | null;
    config?: string;
}

export interface FullLineSettings {
    enabled: boolean;
    device: string;
}

export const LSP_PLUGINS_DIR_NAME = 'LspPlugins';
export const PLUGIN_DLL_NAME = 'FullLineCompletionLspPlugin.dll';
export const DIR_ENV_VARIABLE = 'PABC_FULLLINE_DIR';
export const URL_ENV_VARIABLE = 'PABC_LLM_URL';

const SETUP_DLL_NAME = 'FullLineCompletionSetup.dll';
const CONFIG_FILE_NAME = 'fullline-setup.json';
const STATE_FILE_NAME = 'llama-server-state.json';
const HEALTH_TIMEOUT_MS = 15 * 60 * 1000;

export function getFullLineSettings(): FullLineSettings {
    const configuration = vscode.workspace.getConfiguration('pascalabc');
    return {
        enabled: configuration.get<boolean>('fullLineCompletion.enabled', false),
        device: configuration.get<string>('fullLineCompletion.device', 'auto')
    };
}

// The recommended model is an implementation detail pinned to a Hugging Face
// revision and updated with each extension release — deliberately not a user
// setting. For development PABC_FULLLINE_MODEL_URL overrides the URL.
export const RECOMMENDED_MODEL_URL =
    'https://huggingface.co/PascalABCNET/Qwen-Coder-1.5B_Q4_K_M_full_line_completion' +
    '/resolve/0335a690e63d4c499b225b84690f6627d4b36b6b/completion_qwen_pascal_q4_k_m.gguf';
export const RECOMMENDED_MODEL_REVISION = '0335a690e63d4c499b225b84690f6627d4b36b6b';

export function resolveModelUrl(): string {
    return (process.env.PABC_FULLLINE_MODEL_URL ?? '').trim() || RECOMMENDED_MODEL_URL;
}

// Must match the FullLineCompletionSetup default install directory
// (Environment.SpecialFolder.LocalApplicationData\PascalABC.NET\llama.cpp).
export function getInstallDir(): string {
    const applicationDataDirectory = process.platform === 'win32'
        ? path.join(
            process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'),
            'PascalABC.NET')
        : path.join(os.homedir(), '.local', 'share', 'PascalABC.NET');
    return path.join(applicationDataDirectory, 'llama.cpp');
}

export function getPluginsDir(installDir: string): string {
    return path.join(installDir, LSP_PLUGINS_DIR_NAME);
}

export function getConfigPath(installDir: string): string {
    return path.join(installDir, CONFIG_FILE_NAME);
}

export function getPluginDeployPath(installDir: string): string {
    return path.join(getPluginsDir(installDir), PLUGIN_DLL_NAME);
}

export function readSetupConfig(installDir: string): FullLineSetupConfig | undefined {
    try {
        return normalizeKeys(
            JSON.parse(fs.readFileSync(getConfigPath(installDir), 'utf8'))) as FullLineSetupConfig;
    } catch {
        return undefined;
    }
}

export function readServerState(installDir: string): LlamaServerState | undefined {
    try {
        return normalizeKeys(JSON.parse(
            fs.readFileSync(path.join(installDir, STATE_FILE_NAME), 'utf8'))) as unknown as LlamaServerState;
    } catch {
        return undefined;
    }
}

// The setup tool and the plugin write JSON with default System.Text.Json
// naming (PascalCase: "Port", "ModelPath", ...); TypeScript reads camelCase.
// Normalizing keys once at read keeps the mismatch out of every call site.
function normalizeKeys(value: unknown): Record<string, unknown> {
    const normalized: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        normalized[key.charAt(0).toLowerCase() + key.slice(1)] = item;
    }
    return normalized;
}

export function isInstalled(installDir: string): boolean {
    return fs.existsSync(getConfigPath(installDir)) && fs.existsSync(getPluginDeployPath(installDir));
}

// The plugin dll ships inside the VSIX (bundle approach) and is copied into the
// persistent install directory; re-copying keeps it in sync with extension
// updates. The copy retries: right after the language server stops, Windows
// still holds the deployed dll open for a moment (dying process, antivirus),
// and a single copy attempt fails with EBUSY.
export async function deployPluginDll(context: vscode.ExtensionContext, installDir: string): Promise<void> {
    const bundlePath = context.asAbsolutePath(path.join('fullline', PLUGIN_DLL_NAME));
    if (!fs.existsSync(bundlePath)) {
        throw new Error(`Bundled plugin was not found: ${bundlePath}`);
    }
    const targetPath = getPluginDeployPath(installDir);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    await copyWithRetries(bundlePath, targetPath);
    removeLegacyPluginCopy(context);
}

async function copyWithRetries(sourcePath: string, targetPath: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 20; attempt++) {
        try {
            fs.copyFileSync(sourcePath, targetPath);
            return;
        } catch (error) {
            lastError = error;
            await delay(250);
        }
    }
    throw lastError;
}

// A dll left in the server's default plugins folder (bin/net10/plugins, the
// old manual test loop) is loaded BEFORE the managed copy and shadows it —
// the server only uses the first registered provider. Remove the stray copy so
// the deployed one is the single source of truth.
export function removeLegacyPluginCopy(context: vscode.ExtensionContext): void {
    const legacyPath = context.asAbsolutePath(
        path.join('bin', 'net10', 'plugins', PLUGIN_DLL_NAME));
    try {
        if (fs.existsSync(legacyPath)) {
            fs.rmSync(legacyPath, { force: true });
            console.log(`Removed legacy plugin copy: ${legacyPath}`);
        }
    } catch {
        // Best effort: a locked dll stays until the next restart.
    }
}

export async function stopLlamaServer(installDir: string): Promise<void> {
    const pid = readServerState(installDir)?.pid;
    try {
        fs.rmSync(path.join(installDir, STATE_FILE_NAME), { force: true });
    } catch {
        // Nothing to clean up.
    }
    if (!pid) {
        return;
    }
    try {
        process.kill(pid);
    } catch {
        // The process is already gone.
    }
    // The exe stays locked for a moment after kill(); deleting or replacing it
    // right away fails with EPERM on Windows.
    for (let attempt = 0; attempt < 20; attempt++) {
        try {
            process.kill(pid, 0);
            await delay(250);
        } catch {
            return;
        }
    }
}

export async function removeComponents(installDir: string): Promise<void> {
    await stopLlamaServer(installDir);
    fs.rmSync(installDir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 300
    });
}

export interface SetupRunOptions {
    device: string;
    modelUrl?: string;
    modelRevision?: string;
}

// Runs FullLineCompletionSetup from the VSIX bundle with machine-readable
// progress (--progress json) and surfaces NDJSON events through onProgress.
export async function runSetup(
    context: vscode.ExtensionContext,
    dotnet: string,
    installDir: string,
    options: SetupRunOptions,
    onProgress: (progress: SetupProgress) => void,
    output: vscode.OutputChannel,
    token?: vscode.CancellationToken
): Promise<void> {
    const setupDll = context.asAbsolutePath(path.join('fullline', SETUP_DLL_NAME));
    if (!fs.existsSync(setupDll)) {
        throw new Error(`Bundled setup tool was not found: ${setupDll}`);
    }
    const args = [setupDll, '--dir', installDir, '--device', options.device, '--progress', 'json'];
    if (options.modelUrl) {
        args.push('--model-url', options.modelUrl);
        if (options.modelRevision) {
            args.push('--model-revision', options.modelRevision);
        }
    } else {
        args.push('--no-model');
    }
    output.appendLine(`Running setup: ${dotnet} ${args.join(' ')}`);

    await new Promise<void>((resolve, reject) => {
        const child = spawn(dotnet, args, { windowsHide: true });
        let settled = false;
        let cancelled = token?.isCancellationRequested ?? false;
        const cancelSubscription = token?.onCancellationRequested(() => {
            cancelled = true;
            child.kill();
        });
        const settle = (error?: Error): void => {
            if (settled) {
                return;
            }
            settled = true;
            cancelSubscription?.dispose();
            if (error) {
                reject(error);
            } else {
                resolve();
            }
        };
        child.on('error', error => settle(error));
        child.on('exit', code => {
            if (cancelled) {
                settle(new Error('Установка отменена.'));
            } else if (code !== 0) {
                settle(new Error(`Setup exited with code ${String(code)}.`));
            } else {
                settle();
            }
        });
        if (child.stderr) {
            readline.createInterface({ input: child.stderr, crlfDelay: Infinity })
                .on('line', line => output.appendLine(line));
        }
        if (child.stdout) {
            readline.createInterface({ input: child.stdout, crlfDelay: Infinity })
                .on('line', line => {
                    if (line.startsWith('{')) {
                        try {
                            onProgress(JSON.parse(line) as SetupProgress);
                            return;
                        } catch {
                            // Not an NDJSON event after all.
                        }
                    }
                    output.appendLine(line);
                });
        }
    });
}

// Waits until the plugin-managed llama-server reports a loaded model
// (GET /health == 200). Returns false when readiness cannot be observed.
export async function waitForModelReady(
    installDir: string,
    onMessage?: (message: string) => void
): Promise<boolean> {
    // The state file is re-read on every poll: it can still hold the previous
    // session's llama-server when waiting starts, and the plugin rewrites it
    // only after spawning a new one. Latching onto the stale port once would
    // poll a dead server until the timeout.
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
        const state = readServerState(installDir);
        if (state?.port) {
            if (await isHealthReady(state.port)) {
                return true;
            }
            onMessage?.(`ИИ-модель загружается (llama-server, порт ${state.port})...`);
        } else {
            onMessage?.('ИИ-модель загружается (llama-server запускается)...');
        }
        await delay(1000);
    }
    return false;
}

function isHealthReady(port: number): Promise<boolean> {
    return new Promise<boolean>(resolve => {
        const request = http.get(
            { host: '127.0.0.1', port, path: '/health', timeout: 2000 },
            response => {
                response.resume();
                resolve(response.statusCode === 200);
            });
        request.on('timeout', () => {
            request.destroy();
            resolve(false);
        });
        request.on('error', () => resolve(false));
    });
}

function delay(milliseconds: number): Promise<void> {
    return new Promise<void>(resolve => setTimeout(resolve, milliseconds));
}
