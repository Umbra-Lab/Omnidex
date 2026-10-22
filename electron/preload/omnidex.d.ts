import type { OmnidexBridge } from './index';

declare global {
  interface Window {
    omnidex: OmnidexBridge;
  }
}
