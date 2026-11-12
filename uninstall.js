// Removes the AI full-line completion runtime (llama.cpp, the completion
// model and the LspPlugins folder) when the extension is fully uninstalled.
// Registered as the vscode:uninstall hook in package.json: VS Code runs it
// as a plain Node script on the first startup after the uninstall (no vscode
// API is available here). It does NOT run on updates — that is intentional.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const candidates = [];
if (process.platform === 'win32' && process.env.LOCALAPPDATA) {
    candidates.push(path.join(process.env.LOCALAPPDATA, 'PascalABC.NET', 'llama.cpp'));
}
// Same shape as Environment.SpecialFolder.LocalApplicationData in the setup
// tool; extra candidates cover .NET host differences across platforms.
candidates.push(path.join(os.homedir(), '.local', 'share', 'PascalABC.NET', 'llama.cpp'));
candidates.push(path.join(os.homedir(), 'Library', 'Application Support', 'PascalABC.NET', 'llama.cpp'));

for (const directory of candidates) {
    // Delete only our own installation: fullline-setup.json is the marker
    // written by FullLineCompletionSetup.
    if (!fs.existsSync(path.join(directory, 'fullline-setup.json'))) {
        continue;
    }
    try {
        fs.rmSync(directory, { recursive: true, force: true });
        console.log(`Removed full line completion runtime: ${directory}`);
    } catch (error) {
        console.error(`Failed to remove ${directory}: ${error.message}`);
    }
}
