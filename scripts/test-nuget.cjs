// Exercises the extension's NuGet UI adapter against a real server and a local
// feed. Supply an already cached Newtonsoft.Json 13.0.3 nupkg as the first arg.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const {pathToFileURL} = require('node:url');
const {spawn} = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'pabc-vscode-nuget-'));
const feed = path.join(temporary, 'feed'); fs.mkdirSync(feed);
assert.ok(process.argv[2], 'Provide cached Newtonsoft.Json 13.0.3 nupkg path.');
fs.copyFileSync(process.argv[2], path.join(feed, 'newtonsoft.json.13.0.3.nupkg'));
const xml = value => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
fs.writeFileSync(path.join(temporary, 'NuGet.Config'), `<configuration><packageSources><clear/><add key="local" value="${xml(feed)}"/></packageSources><config><add key="globalPackagesFolder" value="${xml(path.join(temporary, 'cache'))}"/></config></configuration>`);
const file = path.join(temporary, 'test.pas'); fs.writeFileSync(file, 'begin\nend.\n');
const address = pathToFileURL(file).href;
const server = spawn('dotnet', [path.join(root, 'bin/net10/PascalABCNet.LanguageServer.dll'), '--stdio'], {
  cwd: temporary, windowsHide: true, env: {...process.env, NUGET_PACKAGES: path.join(temporary, 'cache')}
});
server.stderr.on('data', value => process.stderr.write(value));
let buffer = Buffer.alloc(0), sequence = 0;
const pending = new Map(), handlers = new Map(), stages = [];
server.stdout.on('data', value => {
  buffer = Buffer.concat([buffer, value]);
  for (;;) {
    const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return;
    const length = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
    if (buffer.length < end + 4 + length) return;
    const message = JSON.parse(buffer.subarray(end + 4, end + 4 + length)); buffer = buffer.subarray(end + 4 + length);
    if (message.id !== undefined) pending.get(message.id)?.(message);
    else { if (message.method === 'pascalabc/nugetRestoreProgress') stages.push(message.params.stage); handlers.get(message.method)?.(message.params); }
  }
});
function send(method, params, notification = false) {
  const id = ++sequence;
  const promise = notification ? Promise.resolve() : new Promise((resolve, reject) => pending.set(id, response => {
    pending.delete(id); response.error ? reject(Object.assign(new Error(response.error.message), response.error)) : resolve(response.result);
  }));
  const message = JSON.stringify({jsonrpc:'2.0', ...(notification ? {} : {id}), method, params});
  server.stdin.write(`Content-Length: ${Buffer.byteLength(message)}\r\n\r\n${message}`); return promise;
}
const disposable = {dispose(){}};
let cancelListener;
const token = {isCancellationRequested:false, onCancellationRequested:listener=>{
  cancelListener=listener; return {dispose(){cancelListener=undefined;}};
}};
let cancelNext = false, cancellationSent = false;
const request = (method, params) => {
  if (cancelNext && method === 'pascalabc/restoreNuGetPackages') {
    queueMicrotask(()=>{token.isCancellationRequested=true;cancelListener?.();});
    return Promise.reject(Object.assign(new Error('Cancelled'), {code:-32800}));
  }
  if (method === 'pascalabc/cancelNuGetRestore') cancellationSent=true;
  return send(method, params);
};
let text = fs.readFileSync(file, 'utf8'), version = 1;
const uri = {scheme:'file', toString:()=>address};
const document = {uri, languageId:'pascalabc', eol:1, getText:()=>text, positionAt:offset=>offset};
const commands = new Map(), errors = [], messages = [], progress = [];
class Position { constructor(line, character) {this.line=line;this.character=character;} }
class Range { constructor(start,end) {this.start=start;this.end=end;} }
class WorkspaceEdit {
  insert(uri, position, value) {this.value=value;this.start=0;this.end=0;}
  replace(uri, range, value) {this.value=value;this.start=range.start;this.end=range.end;}
}
const fake = {
  Position, Range, WorkspaceEdit, EndOfLine:{CRLF:2}, StatusBarAlignment:{Left:1}, ProgressLocation:{Notification:15}, CancellationError:class extends Error {},
  Uri:{parse:()=>uri},
  window:{activeTextEditor:{document}, createOutputChannel:()=>({appendLine:()=>{},...disposable}),
    createStatusBarItem:()=>({show(){},hide(){},...disposable}), onDidChangeActiveTextEditor:()=>disposable,
    showInputBox:async options=>options.title.includes('search') ? 'Newtonsoft.Json' : 'Newtonsoft.Json',
    showQuickPick:async items=>items.find(item=>item === '13.0.3' || item.packageId === 'Newtonsoft.Json'),
    showTextDocument:async()=>{}, showErrorMessage:async value=>errors.push(value), showInformationMessage:async value=>messages.push(value),
    withProgress:async (_, action)=>action({report:value=>progress.push(value)},token)},
  workspace:{onDidCloseTextDocument:()=>disposable, applyEdit:async edit=>{
    text=text.slice(0,edit.start)+edit.value+text.slice(edit.end);
    await send('textDocument/didChange',{textDocument:{uri:address,version:++version},contentChanges:[{text}]},true); return true;
  }},
  commands:{registerCommand:(name,action)=>{commands.set(name,action);return disposable;}}
};
const exported = {};
vm.runInNewContext(fs.readFileSync(path.join(root,'out/nuget.js'),'utf8'), {exports:exported,require:name=>name==='vscode'?fake:name==='vscode-languageclient/node'?{State:{Stopped:1}}:require(name)});
async function main() {
  await send('initialize',{processId:process.pid,capabilities:{},initializationOptions:{manualNuGetRestore:true}});
  await send('initialized',{},true);
  exported.registerNuGet({subscriptions:[]}, {isRunning:()=>true,onDidChangeState:()=>disposable,sendRequest:request,onNotification:(name,handler)=>{handlers.set(name,handler);return disposable;}});
  await send('textDocument/didOpen',{textDocument:{uri:address,languageId:'pascalabc',version,text}},true);
  await commands.get('pascalabc.nugetSearch')();
  assert.ok(text.startsWith('{$package Newtonsoft.Json 13.0.3}'), JSON.stringify(errors));
  await commands.get('pascalabc.nugetVersions')();
  assert.equal((text.match(/\{\$package/g)||[]).length,1,'Updating a version must not duplicate its directive.');
  await commands.get('pascalabc.nugetRestore')();
  assert.equal(errors.length,0,JSON.stringify(errors));
  assert.ok(messages.includes('Пакеты NuGet восстановлены.'),JSON.stringify(messages));
  assert.ok(stages.includes('begin') && stages.includes('end'),JSON.stringify(stages));
  assert.ok(progress.length);
  cancelNext=true;
  await commands.get('pascalabc.nugetRestore')();
  assert.ok(cancellationSent, 'Cancel must use the server request that bypasses the analysis queue.');
  assert.equal(errors.length,0,JSON.stringify(errors));
  cancelNext=false; token.isCancellationRequested=false;
  await commands.get('pascalabc.nugetRestore')();
  assert.equal(errors.length,0,JSON.stringify(errors));
  console.log('PASS NuGet: real local-feed search, versions, directive insertion/update, restore and progress through the extension adapter.');
  console.log('PASS NuGet cancellation adapter: cancel request, no false error, restore can be retried.');
  await send('shutdown',null); await send('exit',null,true);
}
const timeout=setTimeout(()=>{console.error('NuGet test timed out');server.kill();process.exitCode=1;},60000);
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(()=>{clearTimeout(timeout);server.kill();});
