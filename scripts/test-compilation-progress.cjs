const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict'),os=require('node:os');
const root=path.resolve(__dirname,'..');
function load(file,dependencies,extras={}) {
 const exported={};vm.runInNewContext(fs.readFileSync(path.join(root,'out',file),'utf8'),{exports:exported,require:name=>dependencies[name]??require(name),process,console,setTimeout,clearTimeout,...extras});return exported;
}
let show=0,disposed=0,callback,cleared=false;
const status={show(){show++;},dispose(){disposed++;}};
const logs=[];
const output={appendLine(value){logs.push(value);},append(){}};
const {CompilationProgress}=load('compilationProgress.js',{'vscode':{window:{createStatusBarItem:()=>status},StatusBarAlignment:{Left:1}}},{setTimeout:(fn,ms)=>{assert.equal(ms,600);callback=fn;return 1;},clearTimeout:()=>{cleared=true;}});
const fast=new CompilationProgress(output);fast.dispose();assert.equal(show,0);assert.ok(cleared);
const slow=new CompilationProgress(output);callback();assert.equal(show,1);slow.update({event:'compilerState',fileName:'sample.pas',linesCompiled:20});assert.ok(status.text.includes('sample.pas'));slow.dispose();assert.equal(disposed,2);
const counts=[];
class Progress {constructor(){this.count=0;this.display=new CompilationProgress(output);counts.push(this);}update(event){this.count++;this.display.update(event);}dispose(){this.disposed=true;this.display.dispose();}}
const source=fs.readFileSync(path.join(root,'out/extension.js'),'utf8');
const exported={};
vm.runInNewContext(source+'\nexports.Controller=CompilerController;', {exports:exported,require:name=>name==='vscode'?{}:name==='./nuget'?{}:name==='./compilationProgress'?{CompilationProgress:Progress}:name==='vscode-languageclient/node'?{}:require(name),process,console,setTimeout,clearTimeout});
const Controller=exported.Controller;
const probe=new Controller({},output);let resolved=false,events=0;
probe.pending.set(12,{resolve:()=>resolved=true,reject(){},timer:setTimeout(()=>{},1000),onProgress:()=>events++});
probe.handleResponseLine(JSON.stringify({id:12,event:'compilerState',state:'Compiling'}));assert.equal(resolved,false);assert.equal(probe.pending.size,1);assert.equal(events,1);
probe.handleResponseLine(JSON.stringify({id:12,success:true}));assert.equal(resolved,true);assert.equal(probe.pending.size,0);
console.log('PASS delayed progress: quick work stays hidden, slow work shows, disposal clears; events never resolve the compile request.');
async function main(){
 for(const target of ['net-framework','net10']){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'pabc-progress-'));const file=path.join(temp,'probe.pas');fs.writeFileSync(file,"uses ProgressUnit; begin Println(Value); end.");
  const unit=path.join(temp,'ProgressUnit.pas');fs.writeFileSync(unit,'unit ProgressUnit; interface function Value: integer; implementation function Value: integer := 42; end.');
  const runtime=path.join(root,'bin',target);
  const profile={runtimeDirectory:runtime,command:target==='net10'?'dotnet':path.join(runtime,'PABCCompilerController.exe'),args:target==='net10'?[path.join(runtime,'PABCCompilerController.dll')]:[]};
  let controller=new Controller(profile,output);
  try{
   logs.length=0;
   const response=await controller.compile(file,temp,[]);assert.equal(response.success,true,JSON.stringify(response));assert.ok(counts.at(-1).count>0);assert.ok(counts.at(-1).disposed);
   assert.ok(logs.some(line=>line===`Компиляция исходника: ${unit}`),JSON.stringify(logs));
   assert.ok(fs.existsSync(path.join(temp,'ProgressUnit.pcu')));
   controller.dispose();controller=new Controller(profile,output);logs.length=0;
   const warm=await controller.compile(file,temp,[]);assert.equal(warm.success,true,JSON.stringify(warm));
   assert.ok(logs.some(line=>line===`Чтение PCU: ${path.join(temp,'ProgressUnit.pcu')}`),JSON.stringify(logs));
   assert.ok(!logs.some(line=>line===`Компиляция исходника: ${unit}`));
   logs.length=0;
   const changed=await controller.compile(file,temp,[{fileName:unit,text:fs.readFileSync(unit,'utf8').replace(':= 42',':= 73')}]);
   assert.equal(changed.success,true,JSON.stringify(changed));assert.ok(logs.some(line=>line===`Компиляция исходника: ${unit}`),JSON.stringify(logs));
   const failure=await controller.compile(file,temp,[{fileName:file,text:'begin var := ; end.'}]);assert.equal(failure.success,false);assert.ok(counts.at(-1).disposed);
   const cancelled=controller.compile(file,temp,[]);controller.dispose();await assert.rejects(cancelled);assert.ok(counts.at(-1).disposed);
   console.log(`PASS ${target}: real progress events, final success, compilation error and stopped-controller cleanup.`);
   console.log(`PASS ${target}: Output distinguishes source compilation, warm PCU loading and unsaved-module recompilation.`);
  }finally{controller.dispose();}
 }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
