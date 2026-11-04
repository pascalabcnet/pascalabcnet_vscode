// Run with VS Code --extensionTestsPath. Uses generated files in an isolated folder.
const vscode=require('vscode'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict'),{spawnSync}=require('node:child_process');
exports.run=async()=>{
 await vscode.extensions.getExtension('pascalabcnet.multitarget-pascalabc-net').activate();
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'pabc-unsaved-'));
 const modulePath=path.join(directory,'UnsavedModule.pas');
 const disk='unit UnsavedModule; interface function Value: integer; implementation function Value: integer := 1; end.';
 fs.writeFileSync(modulePath,disk);
 const name='UnsavedProbe'+Date.now(); const mainPath=path.join(directory,name+'.pas');
 fs.writeFileSync(mainPath,'uses UnsavedModule; begin Println(Value); end.');
 let module=await vscode.workspace.openTextDocument(modulePath);
 const main=await vscode.workspace.openTextDocument(mainPath);
 const settings=vscode.workspace.getConfiguration('pascalabc');
 const profile=process.env.PABC_VSCODE_TEST_PROFILE;
 assert.ok(profile,'Set PABC_VSCODE_TEST_PROFILE to the isolated VS Code user-data-dir.');
 const output=path.join(profile,'User/globalStorage/pascalabcnet.multitarget-pascalabc-net/output',name+'.exe');
 try {
  for(const target of ['net-framework','net10']) {
   await settings.update('compilerTarget',target,vscode.ConfigurationTarget.Global);
   for(const value of [42,73]) {
    const edit=new vscode.WorkspaceEdit();edit.replace(module.uri,new vscode.Range(module.positionAt(0),module.positionAt(module.getText().length)),disk.replace(':= 1',':= '+value));
    assert.ok(await vscode.workspace.applyEdit(edit));await vscode.window.showTextDocument(main);
    await vscode.commands.executeCommand('pascalabc.compileCurrentFile');
    const result=spawnSync(target==='net10'?'dotnet':output,target==='net10'?[output]:[],{encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),String(value));
    assert.equal(fs.readFileSync(modulePath,'utf8'),disk);assert.ok(module.isDirty);
   }
   const editor=await vscode.window.showTextDocument(module);
   await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
   await vscode.window.showTextDocument(main);await vscode.commands.executeCommand('pascalabc.compileCurrentFile');
   const result=spawnSync(target==='net10'?'dotnet':output,target==='net10'?[output]:[],{encoding:'utf8',windowsHide:true});
   assert.equal(result.status,0,result.stderr);assert.equal(result.stdout.trim(),'1');
   await vscode.commands.executeCommand('pascalabc.restartCompiler');
   console.log(`PASS ${target}: unsaved module edits 42 -> 73, disk unchanged, revert restores disk value 1.`);
   if(target==='net-framework') { module=await vscode.workspace.openTextDocument(modulePath);await vscode.window.showTextDocument(module); }
  }
 }finally {await settings.update('compilerTarget','net10',vscode.ConfigurationTarget.Global);}
};
