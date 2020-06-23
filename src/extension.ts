import * as vscode from 'vscode';
import * as vscodelc from 'vscode-languageclient';

import * as config from './config';
import * as fileStatus from './file-status';
import * as install from './install';
import * as semanticHighlighting from './semantic-highlighting';
import * as switchSourceHeader from './switch-source-header';
import { SemanticHighlightingFeature } from './semantic-highlighting';
import { WorkspaceFolder, Uri, TextDocument } from 'vscode';
import { WorkspaceMiddleware, InitializeResult, ServerCapabilities, InitializeParams, Disposable } from 'vscode-languageclient';

let clients: Map<WorkspaceFolder, ClangdLanguageClient> = new Map();
let highlighting: Map<ClangdLanguageClient, SemanticHighlightingFeature> = new Map();

// Function from MIT licensed example - 
// https://github.com/microsoft/vscode-extension-samples/blob/3f794b7a5a4b5c98b14c71b174b68888e0d24440/lsp-multi-server-sample/client/src/extension.ts#L17
let _sortedWorkspaceFolders: string[] | undefined;
function sortedWorkspaceFolders(): string[] {
  if (_sortedWorkspaceFolders === void 0) {
    _sortedWorkspaceFolders = vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.map(folder => {
      let result = folder.uri.toString();
      if (result.charAt(result.length - 1) !== '/') {
        result = result + '/';
      }
      return result;
    }).sort(
      (a, b) => {
        return a.length - b.length;
      }
    ) : [];
  }
  return _sortedWorkspaceFolders;
}
vscode.workspace.onDidChangeWorkspaceFolders(() => _sortedWorkspaceFolders = undefined);
function getOuterMostWorkspaceFolder(folder: WorkspaceFolder): WorkspaceFolder {
  let sorted = sortedWorkspaceFolders();
  for (let element of sorted) {
    let uri = folder.uri.toString();
    if (uri.charAt(uri.length - 1) !== '/') {
      uri = uri + '/';
    }
    if (uri.startsWith(element)) {
      return vscode.workspace.getWorkspaceFolder(Uri.parse(element))!;
    }
  }
  return folder;
}

class ClangdLanguageClient extends vscodelc.LanguageClient {
  private semanticHighlightingFeature: SemanticHighlightingFeature;

  // Override the default implementation for failed requests. The default
  // behavior is just to log failures in the output panel, however output panel
  // is designed for extension debugging purpose, normal users will not open it,
  // thus when the failure occurs, normal users doesn't know that.
  //
  // For user-interactive operations (e.g. applyFixIt, applyTweaks), we will
  // prompt up the failure to users.
  logFailedRequest(rpcReply: vscodelc.RPCMessageType, error: any) {
    if (error instanceof vscodelc.ResponseError &&
      rpcReply.method === 'workspace/executeCommand')
      vscode.window.showErrorMessage(error.message);
    // Call default implementation.
    super.logFailedRequest(rpcReply, error);
  }

  activate() {
    this.dispose();
    this.startDisposable = this.start();
  }

  dispose() {
    if (this.startDisposable)
      this.startDisposable.dispose();
  }
  private startDisposable: vscodelc.Disposable;

}

class EnableEditsNearCursorFeature implements vscodelc.StaticFeature {
  initialize() { }
  fillClientCapabilities(capabilities: vscodelc.ClientCapabilities): void {
    const extendedCompletionCapabilities: any =
      capabilities.textDocument.completion;
    extendedCompletionCapabilities.editsNearCursor = true;
  }
}

export function createClient(context: vscode.ExtensionContext, path: vscode.Uri): ClangdLanguageClient {
  const clangd: vscodelc.Executable = {
    command: ClangdLanguageClientSettings.clangdPath,
    args: config.getWithURI<string[]>('arguments', path)
  };
  const traceFile = config.get<string>('trace');
  if (!!traceFile) {
    const trace = { CLANGD_TRACE: traceFile };
    clangd.options = { env: { ...process.env, ...trace } };
  }
  const serverOptions: vscodelc.ServerOptions = clangd;

  const clientOptions: vscodelc.LanguageClientOptions = {
    // Register the server for c-family and cuda files.
    documentSelector: [
      { scheme: 'file', language: 'c', pattern: `${path.fsPath}/**/*` },
      { scheme: 'file', language: 'cpp', pattern: `${path.fsPath}/**/*` },
      { scheme: 'file', language: 'cuda', pattern: `${path.fsPath}/**/*` },
      { scheme: 'file', language: 'objective-c', pattern: `${path.fsPath}/**/*` },
      { scheme: 'file', language: 'objective-cpp', pattern: `${path.fsPath}/**/*` },
    ],

    initializationOptions: {
      clangdFileStatus: true,
      fallbackFlags: config.getWithURI<string[]>('fallbackFlags', path)
    },
    // Do not switch to output window when clangd returns output.
    revealOutputChannelOn: vscodelc.RevealOutputChannelOn.Never,

    // We hack up the completion items a bit to prevent VSCode from re-ranking
    // and throwing away all our delicious signals like type information.
    //
    // VSCode sorts by (fuzzymatch(prefix, item.filterText), item.sortText)
    // By adding the prefix to the beginning of the filterText, we get a perfect
    // fuzzymatch score for every item.
    // The sortText (which reflects clangd ranking) breaks the tie.
    // This also prevents VSCode from filtering out any results due to the
    // differences in how fuzzy filtering is applies, e.g. enable dot-to-arrow
    // fixes in completion.
    //
    // We also mark the list as incomplete to force retrieving new rankings.
    // See https://github.com/microsoft/language-server-protocol/issues/898
    middleware: {
      provideCompletionItem:
        async (document, position, context, token, next) => {
          let list = await next(document, position, context, token);
          let items = (Array.isArray(list) ? list : list.items).map(item => {
            // Gets the prefix used by VSCode when doing fuzzymatch.
            let prefix =
              document.getText(new vscode.Range(item.range.start, position))
            if (prefix)
              item.filterText = prefix + '_' + item.filterText;
            return item;
          })
          return new vscode.CompletionList(items, /*isIncomplete=*/ true);
        },
    },
  };

  console.log("Preparing client " + JSON.stringify(clientOptions.documentSelector));

  const client = new ClangdLanguageClient('Clang Language Server',
    serverOptions, clientOptions);

  if (config.get<boolean>('semanticHighlighting')) {
    highlighting.set(client, semanticHighlighting.activate(client, context));
  }

  client.registerFeature(new EnableEditsNearCursorFeature);

  /**
   * HACK/TODO FIX
   * Remove the initalizer for ExecuteCommandFeature when a command is already registered
   * this prevents the double command register exception from being thrown.
   * https://github.com/microsoft/vscode-languageserver-node/blob/1f688e2f65f3a6fc9ba395380cd7b059667a9ecf/client/src/common/client.ts#L2407
   * https://github.com/microsoft/vscode-languageserver-node/issues/333
   */
  if (vscode.commands.getCommands().then(e => e.includes('clangd.applyFix'))) {
    client['_features'][23].initialize = function () { return; };
  }

  return client;
}

namespace ClangdLanguageClientSettings {
  export var clangdPath: string;
}


/**
 *  This method is called when the extension is activated. The extension is
 *  activated the very first time a command is executed.
 */
export async function activate(context: vscode.ExtensionContext) {
  ClangdLanguageClientSettings.clangdPath = await install.activate(context);
  if (!ClangdLanguageClientSettings.clangdPath)
    return;

  const didOpenTextDocument = function didOpenTextDocument(document: TextDocument): void {
    if (document.uri.scheme !== 'file' && document.uri.scheme !== 'untitled') return;
    if (['cpp', 'c', 'cuda', 'objective-c', 'objective-cpp'].indexOf(document.languageId) < 0)
      return;

    let folder = vscode.workspace.getWorkspaceFolder(document.uri);
    if (!folder) return;
    folder = getOuterMostWorkspaceFolder(folder);

    const clientRequest = vscode.workspace.getConfiguration('cpp', folder.uri).get('cppLanguageClient');
    console.log("didOpen: " + document.fileName + ", folder=" + folder.uri + ", configuration=" + clientRequest);
    if (clientRequest !== 'any' && clientRequest !== 'compile')
      return;

    if (!clients.has(folder)) {
      const client = createClient(context, folder.uri);
      clients.set(folder, client);
      console.log('starting clangd for ' + folder.uri);
      client.start();
    }
  }

  vscode.workspace.onDidOpenTextDocument(didOpenTextDocument);
  vscode.workspace.textDocuments.forEach(didOpenTextDocument);

  vscode.workspace.onDidChangeWorkspaceFolders(async (event) => {
    for (let folder of event.removed) {
      let client = clients.get(folder);
      if (client) {
        clients.delete(folder);
        await client.stop();
      }
    }

    for (let folder of event.added) {
      const clientRequest = vscode.workspace.getConfiguration('cpp', folder.uri).get('cppLanguageClient');
      if (clientRequest !== 'any' && clientRequest !== 'compile') {
        if (!clients.get(folder)) {
          const client = createClient(context, folder.uri);
          clients.set(folder, client);
          client.start();
        }
      }
    }

  });

  vscode.workspace.onDidChangeConfiguration(async (e) => {
    if (e.affectsConfiguration('cpp')) {
      for (let folder of vscode.workspace.workspaceFolders) {
        const clientRequest = vscode.workspace.getConfiguration('cpp', folder.uri).get('cppLanguageClient');
        if (clientRequest !== 'any' && clientRequest !== 'compile' && clients.has(folder)) {
          let client = clients.get(folder);
          if (client) {
            await client.stop();
            clients.delete(folder);
          }
        } 
      }
      vscode.workspace.textDocuments.forEach(didOpenTextDocument);
    }

    else if (e.affectsConfiguration('clangd')) {
      await deactivate();
      vscode.workspace.textDocuments.forEach(didOpenTextDocument);
    }
  });

  //context.subscriptions.push(client.start());
  console.log('Clang Language Server is now active!');
  //fileStatus.activate(client, context);
  //switchSourceHeader.activate(client, context);
  // An empty place holder for the activate command, otherwise we'll get an
  // "command is not registered" error.

  context.subscriptions.push(
    vscode.commands.registerCommand('clangd.activate', async () => { }));

  context.subscriptions.push(
    vscode.commands.registerCommand('clangd.restart', async () => { }));

}

export function deactivate(): Thenable<void> {
  let promises: Thenable<void>[] = [];
  for (let client of clients.values()) {
    promises.push(client.stop());
  }
  clients.clear();
  return Promise.all(promises).then(() => undefined);
}