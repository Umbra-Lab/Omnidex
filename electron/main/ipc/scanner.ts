import { ipcMain } from 'electron';
import { activeScanCount, cancelScan, startScan } from '../scanner/pipeline';

let registered = false;

export function registerScannerIpc(): void {
  if (registered) return;
  registered = true;

  ipcMain.handle('omnidex:scanner:start', (_event, locationId: number) => startScan(locationId));

  ipcMain.handle('omnidex:scanner:cancel', (_event, locationId: number) => cancelScan(locationId));

  ipcMain.handle('omnidex:scanner:active-count', () => activeScanCount());
}
