{$reference AsyncIO.dll}
{$reference NaCl.dll}
{$reference NetMQ.dll}
{$reference LanguageIntegrator.dll}

{reference System.Buffers.dll}
{reference System.Memory.dll}
{reference System.Numerics.Vectors.dll}
{reference System.Runtime.CompilerServices.Unsafe.dll}
{reference System.Threading.Tasks.Extensions.dll}
{reference System.ValueTuple.dll}

uses CompileRunHelper;
uses NetMQ.Sockets;
uses NetMQ;
uses PascalABCCompiler;
uses System.IO;
uses System.Text;
uses Languages.Integration;

function CompileFile(c: Compiler; fileName: string): string;
begin
  var response := new StringBuilder;

  try
    var fullFileName := Path.GetFullPath(fileName);

    if not FileExists(fullFileName) then
    begin
      response.AppendLine('ERROR');
      response.AppendLine('Файл не найден: ' + fullFileName);
      Result := response.ToString;
      exit;
    end;

    var options := new CompilerOptions(
      fullFileName,
      CompilerOptions.OutputType.ConsoleApplicaton
    );

    options.UseDllForSystemUnits := True;
    options.Debug := False;
    options.ForDebugging := False;

    c.Reload;

    var outputFileName := c.Compile(options);

    if outputFileName <> nil then
    begin
      response.AppendLine('OK');
      response.AppendLine(outputFileName);
    end
    else
    begin
      response.AppendLine('ERROR');

      if c.ErrorsList.Count = 0 then
        response.AppendLine('Компилятор не создал выходной файл')
      else
        foreach var err in c.ErrorsList do
          response.AppendLine(EnhanceErrorMsg(err));
    end;

  except
    on e: Exception do
    begin
      response.Clear;
      response.AppendLine('FATAL');
      response.AppendLine(e.ToString);
    end;
  end;

  Result := response.ToString;
end;

begin
  if ParamCount = 0 then
  begin
    Console.Error.WriteLine(
      'Ошибка: требуется аргумент с номером TCP-порта'
    );
    Halt(1);
  end;

  var port: integer;

  if not integer.TryParse(ParamStr(1), port) or
     (port < 1) or (port > 65535) then
  begin
    Console.Error.WriteLine(
      'Ошибка: некорректный номер TCP-порта: ' + ParamStr(1)
    );
    Halt(1);
  end;

  var address := 'tcp://127.0.0.1:' + port.ToString;

  StringResourcesLanguage.LoadDefaultConfig;

  Languages.Integration.LanguageIntegrator.LoadAllLanguages();

  var compiler := new Compiler;
  var server := new ResponseSocket;

  try
    server.Bind(address);

    Println('PascalABC.NET compiler server started');
    Println('Address:', address);

    var running := True;

    while running do
    begin
      var request := server.ReceiveFrameString;

      case request of
        '#PING':
        begin
          server.SendFrame('PONG');
        end;

        '#SHUTDOWN':
        begin
          server.SendFrame('BYE');
          running := False;
        end;

        else
        begin
          var response := CompileFile(compiler, request);
          server.SendFrame(response);
        end;
      end;
    end;

  except
    on e: Exception do
      Println(e);
  end;

  server.Dispose;

  Println('PascalABC.NET compiler server stopped');
end.
