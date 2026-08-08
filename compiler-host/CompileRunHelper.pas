unit CompileRunHelper;
{$zerobasedstrings}
{$reference Compiler.dll}
{$reference CompilerTools.dll}
{$reference Errors.dll}
{$reference Localization.dll}
{$reference NetGenerator.dll}
{$reference OptimizerConversion.dll}
{$reference ParserTools.dll}
{$reference PascalABCParser.dll}
{$reference SemanticTree.dll}
{$reference SyntaxTree.dll}
{$reference SyntaxTreeConverters.dll}
{$reference SyntaxVisitors.dll}
{$reference TreeConverter.dll}

uses PascalABCCompiler.Errors;
uses System.IO;
uses PascalABCCompiler;

function Compile(c: Compiler; myfilename: string): string;
begin
  var co := new CompilerOptions(myfilename,CompilerOptions.OutputType.ConsoleApplicaton);
  co.UseDllForSystemUnits := True;
  co.Debug := False;
  co.ForDebugging := False;
  c.Reload;
  Result := c.Compile(co);
end;

function RunProcess(myexefilename: string): string;
begin
  var outputstring := new StringBuilder;
  var pabcnetcProcess := new System.Diagnostics.Process();
  pabcnetcProcess.StartInfo.FileName := myexefilename;
  pabcnetcProcess.StartInfo.UseShellExecute := false;
  //pabcnetcProcess.StartInfo.CreateNoWindow := true;
  pabcnetcProcess.StartInfo.RedirectStandardOutput := true;
  //pabcnetcProcess.StartInfo.RedirectStandardInput := true;
  //pabcnetcProcess.StartInfo.StandardOutputEncoding := System.Text.Encoding.UTF8;
  pabcnetcProcess.EnableRaisingEvents := true;
  var outputOverflow := False;
  pabcnetcProcess.OutputDataReceived += procedure(o,e) -> begin
    if e.Data <> nil then
      if not outputOverflow then
      begin
        outputstring.Append(e.Data);
        if outputstring.Length > 10000 then
        begin
          outputstring.Length := 10000;
          outputOverflow := True;
          outputstring.Append('...');
        end;
        outputstring.AppendLine;
      end;
  end;
  pabcnetcProcess.Start();
  pabcnetcProcess.BeginOutputReadLine();
  pabcnetcProcess.WaitForExit(5000);
  if not pabcnetcProcess.HasExited then // убить процесс если он работвет больше 5 секунд. Скорее всего он завис
  begin
    pabcnetcProcess.Kill;
    outputstring.AppendLine('Программа завершена. Она работала более 5 секунд и, вероятно, зависла');
  end;
  Result := outputstring.ToString;
end;

function Time: string;
begin
  var x := DateTime.Now.TimeOfDay.ToString;
  var ind := Pos('.',x);
  if ind > 0 then
    x := x[:ind];
  Result := x;
end;

procedure Log(txt: string) :=
  &File.AppendAllText('log.txt',Time+' '+txt+#13#10);
function CreateTempPas(code: string): string;
begin
  var myfilename := Path.GetTempFileName();
  myfilename := ChangeFileNameExtension(myfilename,'pas');
  WriteAllText(myfilename,code);
  Result := myfilename
end;

function EnhanceErrorMsg(err0: Object): string;
begin
  var err: LocatedError := err0 as LocatedError;
  var msg := err.ToString;
  var ind1 := msg.IndexOf('(');
  var ind2 := msg.IndexOf(')');
  var pos := '';
  if (ind1 > -1) and (ind2 > -1) then
  begin
    pos := msg?[ind1:ind2+1];
  end;
  if (ind2 > -1) and (ind2 < msg.Length) then
    ind2 := msg.IndexOf(':',ind2);
  if (ind2 > -1) and (ind2 < msg.Length-1) then
    ind2 := msg.IndexOf(':',ind2+1);
  Result := Trim(msg?[ind2+1:]);
  if pos <> '' then
    Result := pos + ': ' + Result;
  if err0 is SemanticError(var semErr) then
  begin
    pos := '(' + semErr.Location.begin_line_num + ',' + semErr.Location.begin_column_num + ')';
    Result := pos + ': ' + Result;
  end;
end;

begin
end.
