import { ipcMain } from 'electron';
import keytar from 'keytar';

/**
 * OS-keychain-backed credential store. Replaces `src-tauri/src/llm/credential_manager.rs`
 * and the Tauri `save_orbital_api_key` / `load_orbital_api_key` / `save_llm_api_key`
 * / `load_llm_api_key` commands.
 *
 * Service names mirror the Tauri naming convention so existing stored
 * credentials survive the migration.
 */

const SERVICE_ORBITAL = 'omnidex.orbital';
const SERVICE_LLM = 'omnidex.llm';
const SERVICE_P4 = 'omnidex.p4';

let registered = false;

export function registerCredentialsIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle(
    'omnidex:creds:save',
    async (_e, args: { kind: string; key: string; value: string }) => {
      const { service, account } = resolveService(args.kind, args.key);
      await keytar.setPassword(service, account, args.value);
      return true;
    },
  );

  ipcMain.handle('omnidex:creds:load', async (_e, args: { kind: string; key: string }) => {
    const { service, account } = resolveService(args.kind, args.key);
    return (await keytar.getPassword(service, account)) ?? '';
  });

  ipcMain.handle('omnidex:creds:delete', async (_e, args: { kind: string; key: string }) => {
    const { service, account } = resolveService(args.kind, args.key);
    return keytar.deletePassword(service, account);
  });
}

function resolveService(kind: string, key: string): { service: string; account: string } {
  switch (kind) {
    case 'orbital':
      return { service: SERVICE_ORBITAL, account: key || 'default' };
    case 'llm':
      return { service: SERVICE_LLM, account: key };
    case 'p4':
      return { service: SERVICE_P4, account: key || 'default' };
    default:
      return { service: `omnidex.${kind}`, account: key };
  }
}
