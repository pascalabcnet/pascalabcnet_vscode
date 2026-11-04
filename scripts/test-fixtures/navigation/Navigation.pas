uses NavUnit;
begin
  var value := 7;
  Step;
  var text := 'abc';
  var first := text.Substring(0, 1);
  Print(value);
  var objectValue := new System.Object;
  var objectType := objectValue.GetType;
end.
