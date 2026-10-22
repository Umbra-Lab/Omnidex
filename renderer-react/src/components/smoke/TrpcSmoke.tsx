import { trpc } from '@/ipc/trpc';

/**
 * Smoke test for the electron-trpc contract. Renders live counts pulled from
 * the main process. Once the main views land in Block 4 this component retires.
 */
export function TrpcSmoke() {
  const total = trpc.assets.totalCount.useQuery();
  const favorites = trpc.assets.favoriteCount.useQuery();
  const fab = trpc.assets.fabCount.useQuery();
  const locations = trpc.scanLocations.list.useQuery();

  return (
    <section className="grid gap-3 rounded-lg border border-surface-800/80 bg-surface-900/40 p-4 [&>*]:cap-14">
      <header className="flex items-center justify-between">
        <h2 className="font-display cap-12 font-semibold uppercase tracking-[0.18em] text-surface-400">
          tRPC smoke
        </h2>
        <span className="font-mono cap-10 text-surface-500">electron-trpc + react-query</span>
      </header>
      {/* cap-* off the grid container — its pseudo-elements would be grid items. */}
      <dl className="grid grid-cols-3 gap-3 font-mono [&>*]:cap-12">
        <Stat label="total" state={total} />
        <Stat label="favorites" state={favorites} />
        <Stat label="fab" state={fab} />
      </dl>
      <div className="flex items-center gap-2 font-mono cap-11 text-surface-400">
        <span className="text-surface-500">scan locations:</span>
        {locations.isPending ? (
          <span className="text-surface-500">loading…</span>
        ) : locations.isError ? (
          <span className="text-danger-500">{locations.error.message}</span>
        ) : (
          <span className="text-surface-200">{locations.data?.length ?? 0}</span>
        )}
      </div>
    </section>
  );
}

interface StatProps {
  readonly label: string;
  readonly state: {
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly error?: { message: string } | null;
    readonly data?: number | undefined;
  };
}

function Stat({ label, state }: StatProps) {
  return (
    <div className="flex flex-col gap-1 rounded-md border border-surface-800/60 bg-surface-950/60 px-3 py-2">
      <dt className="cap-10 uppercase tracking-[0.14em] text-surface-500">{label}</dt>
      <dd className="cap-18 font-semibold tabular-nums text-surface-50">
        {state.isPending ? '…' : state.isError ? '—' : (state.data?.toLocaleString() ?? '0')}
      </dd>
    </div>
  );
}
