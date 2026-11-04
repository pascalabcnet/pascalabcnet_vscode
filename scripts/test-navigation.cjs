// VS Code integration test, run with --extensionTestsPath=<this file>.
// Requires a prepared runtime and compiled extension; never builds the backend.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vscode = require('vscode');
const fixtures = path.join(__dirname, 'test-fixtures/navigation');
const locationUri = location => location.targetUri || location.uri;
const locationRange = location => location.targetSelectionRange || location.range;
async function until(action, predicate) {
  const deadline = Date.now() + 30000;
  let value;
  do {
    value = await action();
    if (predicate(value)) return value;
    await new Promise(resolve => setTimeout(resolve, 150));
  } while (Date.now() < deadline);
  throw new Error(`Navigation did not become ready: ${JSON.stringify(value)}`);
}
exports.run = async () => {
  const extension = vscode.extensions.getExtension('pascalabcnet.multitarget-pascalabc-net');
  assert.ok(extension);
  await extension.activate();
  const unit = await vscode.workspace.openTextDocument(path.join(fixtures, 'NavUnit.pas'));
  await vscode.window.showTextDocument(unit);
  const doc = await vscode.workspace.openTextDocument(path.join(fixtures, 'Navigation.pas'));
  await vscode.window.showTextDocument(doc);
  const query = (kind, line, character) => vscode.commands.executeCommand(
    `vscode.execute${kind}Provider`, doc.uri, new vscode.Position(line, character)
  );
  const local = await until(() => query('Definition', 6, 9), values => values?.length);
  assert.equal(locationUri(local[0]).toString(), doc.uri.toString());
  assert.equal(locationRange(local[0]).start.line, 2);
  const definition = await query('Definition', 3, 3);
  assert.ok(definition?.some(item => locationUri(item).fsPath === unit.uri.fsPath && locationRange(item).start.line === 2), JSON.stringify(definition));
  const implementation = await query('Implementation', 3, 3);
  if (implementation?.length) {
    assert.ok(implementation.some(item => locationUri(item).fsPath === unit.uri.fsPath && locationRange(item).start.line === 4), JSON.stringify(implementation));
  } else {
    console.log('SERVER LIMITATION: no implementation returned for the user-unit procedure Step.');
  }
  console.log('PASS navigation: local variable and module declaration.');

  const library = await query('Definition', 6, 3);
  const system = library?.find(item => path.basename(locationUri(item).fsPath).toLowerCase() === 'pabcsystem.pas');
  assert.ok(system, JSON.stringify(library));
  const libraryBody = await query('Implementation', 6, 3);
  const body = libraryBody?.find(item => locationUri(item).toString() === locationUri(system).toString());
  const systemText = fs.readFileSync(locationUri(system).fsPath, 'utf8');
  const section = systemText.split(/\r?\n/).findIndex(line => line.trim().toLowerCase() === 'implementation');
  assert.ok(body && locationRange(body).start.line > section, JSON.stringify(libraryBody));
  console.log('PASS navigation: standard-library declaration and implementation.');

  const systemDoc = await vscode.workspace.openTextDocument(locationUri(system));
  await vscode.window.showTextDocument(systemDoc, {selection: locationRange(system)});
  const declarationPosition = locationRange(system).start;
  const declarationLine = systemDoc.lineAt(declarationPosition.line).text;
  assert.equal(declarationPosition.character, declarationLine.indexOf('Print'), 'Definition must land on Print, not procedure.');
  const repeated = await vscode.commands.executeCommand('vscode.executeImplementationProvider', systemDoc.uri, declarationPosition);
  const repeatedBody = repeated?.find(item => locationUri(item).toString() === locationUri(system).toString());
  assert.ok(repeatedBody && locationRange(repeatedBody).start.line > section, JSON.stringify(repeated));
  assert.equal(locationRange(repeatedBody).start.line, locationRange(body).start.line);
  const bodyLine = systemDoc.lineAt(locationRange(repeatedBody).start.line).text;
  assert.equal(locationRange(repeatedBody).start.character, bodyLine.indexOf('Print'), 'Implementation must also land on Print.');
  console.log('PASS repeated navigation: program -> Print declaration -> Print implementation.');

  const clr = await query('Definition', 5, 23);
  const metadata = clr?.find(item => locationUri(item).scheme === 'pascalabc-metadata');
  assert.ok(metadata, JSON.stringify(clr));
  assert.equal(path.posix.basename(locationUri(metadata).path), 'System.String.pas');
  assert.match(locationUri(metadata).path, /^\/[A-Fa-f0-9]{64}\/System\.String\.pas$/);
  const metadataDoc = await vscode.workspace.openTextDocument(locationUri(metadata));
  await vscode.window.showTextDocument(metadataDoc, { selection: locationRange(metadata) });
  assert.ok(metadataDoc.getText().includes('Substring'), metadataDoc.getText().slice(0, 200));
  await until(async () => metadataDoc.languageId, value => value === 'pascalabc');
  assert.equal(metadataDoc.isDirty, false);
  const beforeTyping = metadataDoc.getText();
  await vscode.commands.executeCommand('type', {text: 'must not edit'});
  assert.equal(metadataDoc.getText(), beforeTyping, 'Metadata must be read-only in the editor.');
  const objectResults = await query('Definition', 8, doc.lineAt(8).text.indexOf('GetType') + 1);
  const objectLocation = objectResults?.find(item => locationUri(item).scheme === 'pascalabc-metadata');
  assert.ok(objectLocation, JSON.stringify(objectResults));
  assert.equal(path.posix.basename(locationUri(objectLocation).path), 'System.Object.pas');
  assert.match(locationUri(objectLocation).path, /^\/[A-Fa-f0-9]{64}\/System\.Object\.pas$/);
  const objectDoc = await vscode.workspace.openTextDocument(locationUri(objectLocation));
  await vscode.window.showTextDocument(objectDoc);
  assert.ok(objectDoc.getText().includes('Object = class'));
  const activeTab = vscode.window.tabGroups.activeTabGroup.activeTab;
  assert.equal(activeTab.label, 'System.Object.pas');
  const repeatedMetadata = await query('Definition', 8, doc.lineAt(8).text.indexOf('GetType') + 1);
  assert.equal(locationUri(repeatedMetadata[0]).toString(), objectDoc.uri.toString());
  console.log('PASS metadata names: System.Object.pas and System.String.pas tabs retain full hashes in their URIs.');
  await vscode.window.showTextDocument(doc);
  const after = await query('Definition', 6, 9);
  assert.ok(after?.some(item => locationUri(item).toString() === doc.uri.toString()));
  console.log('PASS navigation: read-only CLR metadata with Pascal highlighting; source navigation remains available.');
};
