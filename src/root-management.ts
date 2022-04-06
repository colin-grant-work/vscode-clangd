import * as vscode from 'vscode';
import {ClangdContext, clangdDocumentSelector} from './clangd-context';

export function registerSetRootsCommand(pluginContext: vscode.ExtensionContext,
                                        clangdContext: ClangdContext): void {
  pluginContext.subscriptions.push(vscode.commands.registerCommand(
      'clangd.setRoots', async (newRoots: string[]) => {
        if (!Array.isArray(newRoots) ||
            !newRoots.every(item => typeof item === 'string')) {
          console.log('Received incorrect arguments for "clangd.setRoots"');
          return;
        }
        const {toAdds, toDeletes} = compareCurrentAndDesiredRoots(newRoots);
        reconcileSelectorsAndTargets(toAdds, toDeletes);
        if (toDeletes.size || toAdds.length) {
          await restartCLangDSafely(clangdContext);
        } else {
          console.log(
              'CLangD found that the requested operation produced no change in its parameters.');
        }
      }));
}

function getCurrentRoots(): string[] {
  const selectors = clangdDocumentSelector as vscode.DocumentFilter[];
  return selectors
      .filter((item): item is {pattern: string} =>
                  (item.language === 'c' || item.language === 'cpp') &&
                  typeof item.pattern === 'string')
      .map(({pattern}) => pattern);
}

function compareCurrentAndDesiredRoots(newRoots: string[]) {
  const withGlobs =
      newRoots.map(root => `${root.endsWith('/') ? root : root + '/'}**/*`);
  const current = new Set(getCurrentRoots());
  const toAdds = [];
  for (const glob of withGlobs) {
    if (!current.has(glob)) {
      toAdds.push(glob);
    }
    current.delete(glob);
  }
  // Everything that remains in the current set should be deleted: they didn't
  // appear on the list of targets.
  return {toAdds, toDeletes: current};
}

function reconcileSelectorsAndTargets(toAdds: string[],
                                      toDeletes: Set<string>) {
  const selectors = clangdDocumentSelector as vscode.DocumentFilter[];
  for (const toDelete of toDeletes) {
    let index;
    while ((index = selectors.findIndex(item => item.pattern === toDelete)) !==
           -1) {
      selectors.splice(index, 1);
    }
  }
  for (const toAdd of toAdds) {
    selectors.push({scheme: 'file', language: 'c', pattern: toAdd},
                   {scheme: 'file', language: 'cpp', pattern: toAdd});
  }
}

let simpleCancelation = {canceled: false};
async function restartCLangDSafely(clangdContext: ClangdContext):
    Promise<void> {
  try {
    simpleCancelation.canceled = true;
    const localCancelation = simpleCancelation = {canceled: false};
    await waitForClientReady(clangdContext);
    if (localCancelation.canceled) {
      return;
    }
  } catch {
    // Probably tried to access `onReady` before the client existed.
    return;
  }
  console.log('CLangD has detected a change in its roots and is restarting.');
  vscode.commands.executeCommand('clangd.restart');
  console.log(
      'CLangD is now using this selector to determine what to look at\n' +
      JSON.stringify(clangdDocumentSelector, null, 2));
}

async function waitForClientReady(clangdContext: ClangdContext): Promise<void> {
  while (!clangdContext.client) {
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  await clangdContext.client.onReady();
}
