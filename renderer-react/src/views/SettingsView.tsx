import { useNavigate, useParams } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AboutTab } from '@/features/settings/tabs/AboutTab';
import { AiTab } from '@/features/settings/tabs/AiTab';
import { AssetSourcesTab } from '@/features/settings/tabs/AssetSourcesTab';
import { MarketplaceTab } from '@/features/settings/tabs/MarketplaceTab';
import { StorageTab } from '@/features/settings/tabs/StorageTab';

/**
 * Settings, as a destination rather than a dialog.
 *
 * Almost nothing behind this screen is a preference. Folders are the library's
 * structure, marketplace enrichment is a job that runs for minutes and streams
 * progress, and Storage owns a purge. Those are tasks you come back to, leave
 * running, and want to send someone a link to — and a modal is the one
 * container that supports none of that. It has no address, so "your scan
 * folders are here" is a sentence and not a link; it dies to a stray Escape
 * while a scan is mid-flight; and it stacks badly with the confirm dialogs its
 * own destructive actions open.
 *
 * The tab is in the path, so every tab is its own URL, back goes back through
 * them, and the app can deep-link straight to Folders when onboarding needs it.
 */

export const SETTINGS_TABS = ['folders', 'marketplace', 'storage', 'ai', 'about'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export const DEFAULT_SETTINGS_TAB: SettingsTab = 'folders';

export function isSettingsTab(value: string): value is SettingsTab {
  return (SETTINGS_TABS as readonly string[]).includes(value);
}

export function SettingsView() {
  const { tab } = useParams({ from: '/settings/$tab' });
  const navigate = useNavigate();

  return (
    <div className="h-full w-full overflow-y-auto overflow-x-hidden">
      <div className="mx-auto w-full max-w-4xl px-6 py-6">
        <h1 className="cap-20 font-semibold text-surface-50">Settings</h1>

        <Tabs
          value={tab}
          onValueChange={(next) => void navigate({ to: '/settings/$tab', params: { tab: next } })}
          className="mt-4 flex min-h-0 flex-col"
        >
          <TabsList className="shrink-0 gap-1">
            <GroupLabel>Library</GroupLabel>
            <TabsTrigger value="folders">Folders</TabsTrigger>
            <TabsTrigger value="marketplace">Marketplace</TabsTrigger>
            <TabsTrigger value="storage">Storage</TabsTrigger>
            <GroupLabel className="ml-4">Application</GroupLabel>
            <TabsTrigger value="ai">AI</TabsTrigger>
            <TabsTrigger value="about">About</TabsTrigger>
          </TabsList>
          {/* No height cap and no inner scroller: the route scrolls, so a long
              folder list runs down the page instead of into a box two thirds
              the height of the thing containing it. */}
          <div className="py-5">
            <TabsContent value="folders">
              <AssetSourcesTab />
            </TabsContent>
            <TabsContent value="marketplace">
              <MarketplaceTab />
            </TabsContent>
            <TabsContent value="storage">
              <StorageTab />
            </TabsContent>
            <TabsContent value="ai">
              <AiTab />
            </TabsContent>
            <TabsContent value="about">
              <AboutTab />
            </TabsContent>
          </div>
        </Tabs>
      </div>
    </div>
  );
}

/**
 * Group heading inside the tab strip. `aria-hidden` because a `role="tablist"`
 * may only contain tabs as far as assistive tech is concerned — the grouping is
 * a visual affordance, and each tab's own label already stands alone.
 */
function GroupLabel({
  children,
  className = '',
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={`select-none pl-1 pr-2 font-mono cap-10 uppercase tracking-[0.16em] text-surface-500 ${className}`}
    >
      {children}
    </span>
  );
}
