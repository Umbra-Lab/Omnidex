import { ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { UpdatesCard } from '@/features/updates/UpdatesCard';

const REPO_URL = 'https://github.com/Umbra-Lab/Omnidex';
const PRIVACY_URL = `${REPO_URL}/blob/main/PRIVACY.md`;
const EULA_URL = `${REPO_URL}/blob/main/EULA.md`;
const ORBITAL_URL = 'https://orbital-market.com';
const RELEASES_URL = `${REPO_URL}/releases`;

function openExternal(url: string): void {
  void window.omnidex?.shell?.openExternal(url);
}

export function AboutTab() {
  return (
    <div className="flex flex-col gap-4">
      <UpdatesCard />
      <Card>
        <CardHeader>
          <CardTitle>Privacy &amp; data</CardTitle>
          <CardDescription>
            Omnidex is a local indexer. Your library stays on your machine — here is exactly what
            leaves it.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 cap-11-prose text-surface-300">
          <p>
            To enrich your assets with titles, thumbnails, and other metadata, Omnidex contacts two
            external sources. The only data that leaves your machine is described below.
          </p>

          <Item title="Asset names → orbital-market.com">
            When you run marketplace enrichment, each asset pack&apos;s <em>name</em> is sent as a
            search query to <ExternalTextLink url={ORBITAL_URL} label="orbital-market.com" />, a
            community catalog mirror that is <strong>not affiliated with Epic or FAB</strong>. It is
            a third-party source and may be unavailable; when it is, you simply get fewer matches.
            Your file paths, folder structure, and file contents are never sent.
          </Item>

          <Item title="Your owned library → Epic / FAB">
            Only if you connect your Epic account: Omnidex uses <em>your own</em> Epic login to
            fetch <em>your own</em> owned FAB library from Epic&apos;s servers. Your Epic
            credentials go to Epic and nowhere else.
          </Item>

          <Item title="Update checks → github.com">
            Off by default. Only if you press <em>Check for updates</em>, or turn on{' '}
            <em>Check automatically</em>, Omnidex requests the release list and update manifest from{' '}
            <ExternalTextLink url={RELEASES_URL} label="github.com/Umbra-Lab/Omnidex" />. GitHub
            sees your IP address and a user-agent naming Omnidex, its version and your operating
            system. No library data, file paths, or identifiers are sent, and nothing is downloaded
            until you choose <em>Download update</em>.
          </Item>

          <Item title="No telemetry, no analytics">
            Omnidex collects <strong>no</strong> usage tracking, analytics, or crash reporting.
            There is no Omnidex server, and nothing is sent anywhere on its own unless you turn on
            automatic update checks.
          </Item>

          <p className="cap-10-prose text-surface-400">
            Enrichment is on when you run it; there is not yet an in-app toggle to disable
            individual sources. The FAB step never runs unless you have connected an Epic account.
            Full details are in the privacy disclosure.
          </p>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 pt-1">
            <DocLink url={PRIVACY_URL} label="Privacy disclosure" />
            <DocLink url={EULA_URL} label="End-user terms" />
            <DocLink url={ORBITAL_URL} label="orbital-market.com" />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Item({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-mono cap-10 font-semibold uppercase tracking-[0.14em] text-surface-400">
        {title}
      </span>
      <p>{children}</p>
    </div>
  );
}

function ExternalTextLink({ url, label }: { readonly url: string; readonly label: string }) {
  return (
    <button
      type="button"
      onClick={() => openExternal(url)}
      className="text-accent-400 underline-offset-4 hover:underline"
    >
      {label}
    </button>
  );
}

function DocLink({ url, label }: { readonly url: string; readonly label: string }) {
  return (
    <button
      type="button"
      onClick={() => openExternal(url)}
      className="inline-flex items-center gap-1 font-mono cap-10 uppercase tracking-[0.14em] text-accent-400 hover:underline"
    >
      {label}
      <ExternalLink size={11} />
    </button>
  );
}
