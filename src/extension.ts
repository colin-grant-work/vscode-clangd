import * as vscode from 'vscode';

import {ClangdContext, clangdDocumentSelector} from './clangd-context';

/**
 *  This method is called when the extension is activated. The extension is
 *  activated the very first time a command is executed.
 */
export async function activate(context: vscode.ExtensionContext) {
  const outputChannel = vscode.window.createOutputChannel('clangd');
  context.subscriptions.push(outputChannel);

  const clangdContext = new ClangdContext;
  context.subscriptions.push(clangdContext);

  context.subscriptions.push(vscode.commands.registerCommand(
      'clangd.setRoots', (newRoots: string[]) => {
        const selectors = clangdDocumentSelector as vscode.DocumentFilter[];
        if (!Array.isArray(newRoots) ||
            !newRoots.every(item => typeof item === 'string')) {
          console.log('Received incorrect arguments for "clangd.setRoots"');
          return;
        }
        const withGlobs = newRoots.map(
            root => `${root.endsWith('/') ? root : root + '/'}**/*`);
        const current =
            new Set(selectors
                        .filter(item => item.language === 'c' &&
                                        typeof item.pattern === 'string')
                        .map(({pattern}) => pattern));
        const toAdds = [];
        for (const glob of withGlobs) {
          if (!current.has(glob)) {
            toAdds.push(glob);
          }
          current.delete(glob);
        }
        // All that are left are things that were not on the latest list
        for (const toDelete of current) {
          const index = selectors.findIndex(item => item.pattern === toDelete)
          if (index !== -1) {
            selectors.splice(index, 1);
          }
        }
        for (const toAdd of toAdds) {
          selectors.push({scheme: 'file', language: 'c', pattern: toAdd},
                         {scheme: 'file', language: 'cpp', pattern: toAdd});
        }
        if (current.size) {
          console.log(
              'ClangD has detected a deletion in of a root and is restarting.');
          vscode.commands.executeCommand('clangd.restart');
        } else {
          console.log(
              'CLangD has detected a change in its roots and its reinitializing.')
          clangdContext.client['initializeFeatures']();
        }
        console.log(
            'CLangD is now using this selector to determine what to look at\n' +
            JSON.stringify(selectors, null, 2));
      }));

  // An empty place holder for the activate command, otherwise we'll get an
  // "command is not registered" error.
  context.subscriptions.push(
      vscode.commands.registerCommand('clangd.activate', async () => {}));
  context.subscriptions.push(
      vscode.commands.registerCommand('clangd.restart', async () => {
        await clangdContext.dispose();
        await clangdContext.activate(context.globalStoragePath, outputChannel,
                                     context.workspaceState);
      }));

  await clangdContext.activate(context.globalStoragePath, outputChannel,
                               context.workspaceState);

  const shouldCheck = vscode.workspace.getConfiguration('clangd').get(
      'detectExtensionConflicts');
  if (shouldCheck) {
    const interval = setInterval(function() {
      const cppTools = vscode.extensions.getExtension('ms-vscode.cpptools');
      if (cppTools && cppTools.isActive) {
        const cppToolsConfiguration =
            vscode.workspace.getConfiguration('C_Cpp');
        const cppToolsEnabled = cppToolsConfiguration.get('intelliSenseEngine');
        if (cppToolsEnabled !== 'Disabled') {
          vscode.window
              .showWarningMessage(
                  'You have both the Microsoft C++ (cpptools) extension and ' +
                      'clangd extension enabled. The Microsoft IntelliSense features ' +
                      'conflict with clangd\'s code completion, diagnostics etc.',
                  'Disable IntelliSense', 'Never show this warning')
              .then(selection => {
                if (selection == 'Disable IntelliSense') {
                  cppToolsConfiguration.update(
                      'intelliSenseEngine', 'Disabled',
                      vscode.ConfigurationTarget.Global);
                } else if (selection == 'Never show this warning') {
                  vscode.workspace.getConfiguration('clangd').update(
                      'detectExtensionConflicts', false,
                      vscode.ConfigurationTarget.Global);
                  clearInterval(interval);
                }
              });
        }
      }
    }, 5000);
  }
}
