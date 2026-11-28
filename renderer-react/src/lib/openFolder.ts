import { toast } from '@/components/ui/toaster';

/**
 * Open an asset's folder in the system file manager, and say so when it can't.
 *
 * The main process refuses a path outside the active scan folders and reports
 * a folder that is gone. The menus used to fire and forget, so on a pack that
 * moved, or one in a paused folder, the click did nothing at all.
 */
export async function openFolder(path: string): Promise<boolean> {
  const shell = window.omnidex?.shell;
  if (!shell) {
    toast.error('Opening folders only works in the desktop app.');
    return false;
  }
  try {
    const result = await shell.openFileLocation(path);
    if (result.ok) return true;
    toast.error(openFolderError(result.error));
  } catch (err) {
    toast.error(openFolderError(err instanceof Error ? err.message : undefined));
  }
  return false;
}

/** The toast for a refused or failed open, in the user's terms. */
export function openFolderError(error: string | undefined): string {
  if (error === 'not found') {
    return "That folder isn't there any more. Rescan its scan folder to update the library.";
  }
  if (error === 'path not allowed') {
    return "That folder isn't in an active scan folder. Turn its scan folder back on in Settings → Folders.";
  }
  return `Couldn't open the folder${error ? `: ${error}` : '.'}`;
}
