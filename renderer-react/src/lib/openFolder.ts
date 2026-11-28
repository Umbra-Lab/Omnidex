import { toast } from '@/components/ui/toaster';

/**
 * Open an asset's folder in the system file manager, and say so when it can't.
 *
 * The main process refuses a path outside the active scan folders, opens the
 * parent of a folder that is gone (a pack that moved), and reports a location
 * whose parent is gone too (an unplugged drive). The menus used to fire and
 * forget, so a refused path did nothing at all and a moved pack silently
 * showed its parent.
 */
export async function openFolder(path: string): Promise<boolean> {
  const shell = window.omnidex?.shell;
  if (!shell) {
    toast.error('Opening folders only works in the desktop app.');
    return false;
  }
  try {
    const result = await shell.openFileLocation(path);
    if (result.ok) {
      if (result.openedParent) {
        toast.info(
          "That folder isn't there any more, so its parent opened. Rescan its scan folder to update the library.",
        );
      }
      return true;
    }
    toast.error(openFolderError(result.error));
  } catch (err) {
    toast.error(openFolderError(err instanceof Error ? err.message : undefined));
  }
  return false;
}

/** The toast for a refused or failed open, in the user's terms. */
export function openFolderError(error: string | undefined): string {
  if (error === 'not found') {
    // The parent is gone too: usually a drive that isn't connected, where a
    // rescan would only mark everything missing.
    return "That location isn't available. If it's on a drive that isn't connected, connect it and try again.";
  }
  if (error === 'path not allowed') {
    return 'That location is outside your scan folders. If its scan folder is turned off, turn it back on in Settings → Folders.';
  }
  return `Couldn't open that location${error ? `: ${error}` : '.'}`;
}
