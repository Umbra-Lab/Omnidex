import { createTRPCReact } from '@trpc/react-query';
import type { AppRouter } from '../../../electron/main/trpc/router';

/**
 * Typed React Query hooks over the electron-trpc transport.
 *
 * Usage:
 *   const { data, isPending } = trpc.assets.totalCount.useQuery();
 *   const favorite = trpc.assets.setFavorite.useMutation();
 */
export const trpc = createTRPCReact<AppRouter>();
