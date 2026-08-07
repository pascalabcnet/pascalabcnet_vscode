{$reference AsyncIO.dll}
{$reference NaCl.dll}
{$reference NetMQ.dll}
{$reference System.Buffers.dll}
{$reference System.Memory.dll}
{$reference System.Numerics.Vectors.dll}
{$reference System.Runtime.CompilerServices.Unsafe.dll}
{$reference System.Threading.Tasks.Extensions.dll}
{$reference System.ValueTuple.dll}

{$reference System.Web.Extensions.dll}

uses NetMQ;
uses NetMQ.Sockets;
uses System;
uses System.Diagnostics;
uses System.IO;
uses System.Net;
uses System.Net.Sockets;
uses System.Threading;
uses System.Collections.Generic;
uses System.Web.Script.Serialization;
uses System.Text.RegularExpressions;

function CreateClient(address: string): RequestSocket;
begin
  var client := new RequestSocket;
  client.Options.Linger := TimeSpan.Zero;
  client.Connect(address);
  Result := client;
end;

procedure DisposeClient(var client: RequestSocket);
begin
  if client = nil then
    exit;

  client.Dispose;
  client := nil;
end;

procedure Log(messageText: string);
begin
  Console.Error.WriteLine(messageText);
  Console.Error.Flush;
end;

function GetFreeLocalPort: integer;
begin
  var listener := new TcpListener(IPAddress.Loopback, 0);

  try
    listener.Start;
    Result := (listener.LocalEndpoint as IPEndPoint).Port;
  finally
    listener.Stop;
  end;
end;

procedure WriteJson(
  serializer: JavaScriptSerializer;
  response: Dictionary<string, object>
);
begin
  Console.WriteLine(serializer.Serialize(response));
  Console.Out.Flush;
end;

function CreateResponse(
  requestId: integer;
  success: boolean
): Dictionary<string, object>;
begin
  var response := new Dictionary<string, object>;
  response['id'] := requestId;
  response['success'] := success;
  Result := response;
end;

function GetString(
  request: Dictionary<string, object>;
  name: string;
  defaultValue: string := ''
): string;
begin
  if not request.ContainsKey(name) then
  begin
    Result := defaultValue;
    exit;
  end;

  var value := request[name];

  if value = nil then
  begin
    Result := defaultValue;
    exit;
  end;

  Result := value.ToString;
end;

function GetInteger(
  request: Dictionary<string, object>;
  name: string;
  defaultValue: integer := 0
): integer;
begin
  if not request.ContainsKey(name) then
  begin
    Result := defaultValue;
    exit;
  end;

  try
    Result := Convert.ToInt32(request[name]);
  except
    Result := defaultValue;
  end;
end;

function StartWorker(
  workerFileName: string;
  port: integer
): Process;
begin
  if not FileExists(workerFileName) then
    raise new FileNotFoundException(
      'Не найден ZMQServerPas: ' + workerFileName
    );

  var startInfo := new ProcessStartInfo;

  startInfo.FileName := workerFileName;
  startInfo.Arguments := port.ToString;
  startInfo.WorkingDirectory :=
    Path.GetDirectoryName(workerFileName);

  startInfo.UseShellExecute := False;
  startInfo.CreateNoWindow := True;

  // Вывод worker нельзя допускать в stdout контроллера:
  // stdout занят протоколом JSON Lines.
  startInfo.RedirectStandardOutput := True;
  startInfo.RedirectStandardError := True;

  var worker := new Process;
  worker.StartInfo := startInfo;
  worker.EnableRaisingEvents := True;

  worker.OutputDataReceived += procedure(sender, e) ->
  begin
    if e.Data <> nil then
      Log('[worker] ' + e.Data);
  end;

  worker.ErrorDataReceived += procedure(sender, e) ->
  begin
    if e.Data <> nil then
      Log('[worker error] ' + e.Data);
  end;

  if not worker.Start then
    raise new Exception('Не удалось запустить ZMQServerPas');

  worker.BeginOutputReadLine;
  worker.BeginErrorReadLine;

  Result := worker;
end;

procedure WaitUntilReady(
  worker: Process;
  address: string;
  var client: RequestSocket
);
begin
  var finishTime := DateTime.UtcNow.AddSeconds(10);

  while DateTime.UtcNow < finishTime do
  begin
    if worker.HasExited then
      raise new Exception(
        'ZMQServerPas завершился с кодом ' +
        worker.ExitCode.ToString
      );

    DisposeClient(client);
    client := CreateClient(address);

    try
      client.SendFrame('#PING');

      var response := '';

      if client.TryReceiveFrameString(
        TimeSpan.FromMilliseconds(500),
        response
      ) and (response = 'PONG') then
        exit;
    except
      on e: Exception do
      begin
        // Worker ещё может не успеть открыть сокет.
      end;
    end;

    Thread.Sleep(100);
  end;

  raise new TimeoutException(
    'ZMQServerPas не ответил на #PING за 10 секунд'
  );
end;

procedure StartWorkerAndConnect(
  workerFileName: string;
  port: integer;
  address: string;
  var worker: Process;
  var client: RequestSocket
);
begin
  worker := StartWorker(workerFileName, port);

  try
    WaitUntilReady(worker, address, client);
  except
    if not worker.HasExited then
      worker.Kill;

    worker.Dispose;
    worker := nil;

    DisposeClient(client);

    raise;
  end;

  Log(
    'ZMQServerPas запущен, PID = ' +
    worker.Id.ToString
  );
end;

procedure StopWorker(
  address: string;
  var worker: Process;
  var client: RequestSocket
);
begin
  DisposeClient(client);

  if worker = nil then
    exit;

  if not worker.HasExited then
  begin
    var shutdownClient: RequestSocket := nil;

    try
      shutdownClient := CreateClient(address);
      shutdownClient.SendFrame('#SHUTDOWN');

      var response := '';

      shutdownClient.TryReceiveFrameString(
        TimeSpan.FromMilliseconds(500),
        response
      );
    except
      on e: Exception do
      begin
        // При невозможности штатного завершения
        // worker будет остановлен принудительно.
      end;
    end;

    DisposeClient(shutdownClient);

    if not worker.WaitForExit(1500) then
      worker.Kill;
  end;

  worker.Dispose;
  worker := nil;
end;

procedure RestartWorker(
  workerFileName: string;
  port: integer;
  address: string;
  var worker: Process;
  var client: RequestSocket
);
begin
  Log('Перезапуск ZMQServerPas');

  StopWorker(address, worker, client);

  Thread.Sleep(100);

  StartWorkerAndConnect(
    workerFileName,
    port,
    address,
    worker,
    client
  );
end;

function TrySendRequest(
  client: RequestSocket;
  request: string;
  timeout: TimeSpan;
  var response: string
): boolean;
begin
  try
    client.SendFrame(request);
    Result :=
      client.TryReceiveFrameString(timeout, response);
  except
    Result := False;
  end;
end;

function SendRequest(
  request: string;
  workerFileName: string;
  port: integer;
  address: string;
  var worker: Process;
  var client: RequestSocket
): string;
begin
  for var attempt := 1 to 2 do
  begin
    var response := '';

    if TrySendRequest(
      client,
      request,
      TimeSpan.FromMinutes(5),
      response
    ) then
    begin
      Result := response;
      exit;
    end;

    if attempt = 1 then
    begin
      Log(
        'ZMQServerPas не ответил. ' +
        'Выполняется перезапуск'
      );

      RestartWorker(
        workerFileName,
        port,
        address,
        worker,
        client
      );
    end;
  end;

  raise new Exception(
    'Не удалось получить ответ от ZMQServerPas'
  );
end;

function GetWorkingSetMB(worker: Process): int64;
begin
  if (worker = nil) or worker.HasExited then
  begin
    Result := 0;
    exit;
  end;

  worker.Refresh;
  Result := worker.WorkingSet64 div (1024 * 1024);
end;

procedure ParseCompileResponse(
  workerResponse: string;
  sourceFileName: string;
  response: Dictionary<string, object>
);
begin
  var normalized :=
    workerResponse.Replace(#13#10, #10).Replace(#13, #10);

  var lines := normalized.Split(#10);

  var diagnostics :=
    new List<Dictionary<string, object>>;

  response['diagnostics'] := diagnostics;

  if (lines.Length > 0) and (lines[0] = 'OK') then
  begin
    response['success'] := True;

    if lines.Length > 1 then
      response['outputFile'] := lines[1].Trim
    else response['outputFile'] := '';

    response['message'] := '';
    exit;
  end;

  response['success'] := False;
  response['outputFile'] := '';

  var firstLine := 0;

  if (lines.Length > 0) and
     ((lines[0] = 'ERROR') or (lines[0] = 'FATAL')) then
    firstLine := 1;

  var messageText := '';

  // Формат текущего EnhanceErrorMsg:
  // (2,4): Ожидалось '.'
  var errorPattern :=
    new Regex(
      '^\s*\((\d+),\s*(\d+)\):\s*(.*)$',
      RegexOptions.CultureInvariant
    );

  for var i := firstLine to lines.Length - 1 do
  begin
    var lineText := lines[i].Trim;

    if lineText = '' then
      continue;

    if messageText <> '' then
      messageText += NewLine;

    messageText += lineText;

    var match1 := errorPattern.Match(lineText);

    var diagnostic :=
      new Dictionary<string, object>;

    diagnostic['fileName'] := sourceFileName;
    diagnostic['severity'] := 'error';

    if match1.Success then
    begin
      diagnostic['line'] :=
        integer.Parse(match1.Groups[1].Value);

      diagnostic['column'] :=
        integer.Parse(match1.Groups[2].Value);

      diagnostic['message'] :=
        match1.Groups[3].Value;
    end
    else
    begin
      diagnostic['line'] := 1;
      diagnostic['column'] := 1;
      diagnostic['message'] := lineText;
    end;

    diagnostics.Add(diagnostic);
  end;

  if messageText = '' then
    messageText := workerResponse;

  response['message'] := messageText;
end;

begin
  var serializer := new JavaScriptSerializer;

  var workerFileName :=
    Path.Combine(
      AppDomain.CurrentDomain.BaseDirectory,
      'ZMQServerPas.exe'
    );

  if ParamCount >= 1 then
    workerFileName := ParamStr(1);

  workerFileName := Path.GetFullPath(workerFileName);

  var port := GetFreeLocalPort;

  // 0 — перезапуск по количеству компиляций отключён.
  var maxCompilations := 0;

  if ParamCount >= 2 then
    maxCompilations := integer.Parse(ParamStr(2));

  // 0 — перезапуск по памяти отключён.
  var maxWorkingSetMB := int64(0);

  if ParamCount >= 3 then
    maxWorkingSetMB := int64.Parse(ParamStr(3));

  var address :=
    'tcp://127.0.0.1:' + port.ToString;

  Log('Адрес ZMQServerPas: ' + address);

  var worker: Process := nil;
  var client: RequestSocket := nil;
  var compilationCount := 0;
  var running := True;

  try
    StartWorkerAndConnect(
      workerFileName,
      port,
      address,
      worker,
      client
    );

    Log('PABCCompilerController готов');

    while running do
    begin
      var inputLine := Console.ReadLine;

      if inputLine = nil then
        break;

      if inputLine.Trim = '' then
        continue;

      var requestId := 0;

      try
        var request :=
          serializer.Deserialize&<Dictionary<string, object>>(
            inputLine
          );

        requestId := GetInteger(request, 'id');
        var command :=
          GetString(request, 'command').ToLower;

        case command of
          'ping':
          begin
            var workerResponse := SendRequest(
              '#PING',
              workerFileName,
              port,
              address,
              worker,
              client
            );

            var response :=
              CreateResponse(requestId, workerResponse = 'PONG');

            response['result'] := workerResponse;
            response['workerPid'] := worker.Id;
            response['workingSetMB'] :=
              GetWorkingSetMB(worker);

            WriteJson(serializer, response);
          end;

          'compile':
          begin
            var fileName :=
              GetString(request, 'fileName');

            if fileName = '' then
            begin
              var response :=
                CreateResponse(requestId, False);

              response['outputFile'] := '';
              response['message'] :=
                'Не задано поле fileName';

              WriteJson(serializer, response);
              continue;
            end;

            fileName := Path.GetFullPath(fileName);

            var workerResponse := SendRequest(
              fileName,
              workerFileName,
              port,
              address,
              worker,
              client
            );

            compilationCount += 1;

            var workingSetMB :=
              GetWorkingSetMB(worker);

            var response :=
              CreateResponse(requestId, False);

            ParseCompileResponse(
              workerResponse,
              fileName,
              response
            );

            response['fileName'] := fileName;
            response['compilationCount'] :=
              compilationCount;
            response['workerPid'] := worker.Id;
            response['workingSetMB'] :=
              workingSetMB;

            WriteJson(serializer, response);

            Log(
              'Компиляций: ' +
              compilationCount.ToString +
              ', память: ' +
              workingSetMB.ToString +
              ' MB'
            );

            var restartByCount :=
              (maxCompilations > 0) and
              (compilationCount >= maxCompilations);

            var restartByMemory :=
              (maxWorkingSetMB > 0) and
              (workingSetMB >= maxWorkingSetMB);

            if restartByCount or restartByMemory then
            begin
              RestartWorker(
                workerFileName,
                port,
                address,
                worker,
                client
              );

              compilationCount := 0;
            end;
          end;

          'restart':
          begin
            RestartWorker(
              workerFileName,
              port,
              address,
              worker,
              client
            );

            compilationCount := 0;

            var response :=
              CreateResponse(requestId, True);

            response['result'] := 'restarted';
            response['workerPid'] := worker.Id;

            WriteJson(serializer, response);
          end;

          'shutdown':
          begin
            var response :=
              CreateResponse(requestId, True);

            response['result'] := 'shutdown';

            WriteJson(serializer, response);

            running := False;
          end;

          else
          begin
            var response :=
              CreateResponse(requestId, False);

            response['message'] :=
              'Неизвестная команда: ' + command;

            WriteJson(serializer, response);
          end;
        end;

      except
        on e: Exception do
        begin
          var response :=
            CreateResponse(requestId, False);

          response['message'] := e.Message;
          response['errorType'] :=
            e.GetType.FullName;

          WriteJson(serializer, response);

          Log(e.ToString);
        end;
      end;
    end;

  except
    on e: Exception do
    begin
      Log('Критическая ошибка контроллера:');
      Log(e.ToString);
    end;
  end;

  StopWorker(address, worker, client);
  NetMQConfig.Cleanup;
end.
