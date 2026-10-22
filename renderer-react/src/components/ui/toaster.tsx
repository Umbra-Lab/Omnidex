import { Toaster as SonnerToaster } from 'sonner';

export function Toaster() {
  return (
    <SonnerToaster
      theme="dark"
      position="bottom-right"
      // No `richColors` — it injects Sonner's own palette and overrides our
      // OKLCH tokens. Instead we map the semantic toast types onto the design
      // tokens via `--normal-*` / per-type CSS vars so success/error/warning
      // stay consistent with the rest of the app.
      style={
        {
          '--normal-bg': 'var(--color-surface-900)',
          '--normal-border': 'var(--color-surface-800)',
          '--normal-text': 'var(--color-surface-50)',
          '--success-bg': 'var(--color-surface-900)',
          '--success-border': 'var(--color-success-500)',
          '--success-text': 'var(--color-surface-50)',
          '--error-bg': 'var(--color-surface-900)',
          '--error-border': 'var(--color-danger-500)',
          '--error-text': 'var(--color-surface-50)',
          '--warning-bg': 'var(--color-surface-900)',
          '--warning-border': 'var(--color-warning-500)',
          '--warning-text': 'var(--color-surface-50)',
          '--info-bg': 'var(--color-surface-900)',
          '--info-border': 'var(--color-accent-500)',
          '--info-text': 'var(--color-surface-50)',
        } as React.CSSProperties
      }
      toastOptions={{
        className:
          'group font-sans cap-14 rounded-md border border-surface-800/80 bg-surface-900 text-surface-50 shadow-xl',
      }}
    />
  );
}

export { toast } from 'sonner';
