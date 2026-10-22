import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReactQueryDevtools } from '@tanstack/react-query-devtools';
import { ipcLink } from 'electron-trpc/renderer';
import { type ReactNode, useState } from 'react';
import { toast } from '@/components/ui/toaster';
import { trpc } from './trpc';

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'Something went wrong';
}

interface TrpcProviderProps {
  readonly children: ReactNode;
}

export function TrpcProvider({ children }: TrpcProviderProps) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        // Honest global error surface: any failed query, and any failed
        // mutation that doesn't supply its own `onError`, raises a toast. This
        // is the safety net — feature mutations may still add a specific
        // `onError` for tailored copy, in which case the global stays silent to
        // avoid a duplicate toast.
        queryCache: new QueryCache({
          onError: (error) => {
            toast.error(errorMessage(error));
          },
        }),
        mutationCache: new MutationCache({
          onError: (error, _vars, _ctx, mutation) => {
            if (mutation.options.onError) return;
            toast.error(errorMessage(error));
          },
        }),
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: 1,
          },
        },
      }),
  );
  const [trpcClient] = useState(() =>
    trpc.createClient({
      // tRPC v11 dropped the root-level `transformer` option (it now lives on
      // the individual links). The patched electron-trpc@1.0.0-alpha.0 (see
      // patches/) detects a missing transformer and falls back to superjson,
      // matching the router's `initTRPC.create({ transformer: superjson })`.
      links: [ipcLink()],
    }),
  );

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        {children}
        {import.meta.env.DEV ? <ReactQueryDevtools initialIsOpen={false} /> : null}
      </QueryClientProvider>
    </trpc.Provider>
  );
}
