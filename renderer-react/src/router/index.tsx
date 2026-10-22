import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { AppShell } from '@/components/layout/AppShell';
import { AssetsView } from '@/views/AssetsView';
import { CollectionDetail } from '@/views/CollectionDetail';
import { CollectionsView } from '@/views/CollectionsView';
import { LearnView } from '@/views/LearnView';
import { LibraryHealthView } from '@/views/LibraryHealthView';
import { MatchView } from '@/views/MatchView';
import { NotFoundView } from '@/views/NotFoundView';
import { DEFAULT_SETTINGS_TAB, isSettingsTab, SettingsView } from '@/views/SettingsView';

const rootRoute = createRootRoute({
  component: () => (
    <AppShell>
      <Outlet />
    </AppShell>
  ),
  notFoundComponent: NotFoundView,
});

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: AssetsView,
});

const assetsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/assets',
  component: AssetsView,
});

const collectionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/collections',
  component: CollectionsView,
});

const collectionDetailRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/collections/$collectionId',
  component: CollectionDetail,
});

const matchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/match',
  component: MatchView,
});

const learnRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/learn',
  component: LearnView,
});

const healthRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/health',
  component: LibraryHealthView,
});

// `/settings` alone has no content of its own, so it resolves to the first tab
// rather than rendering an empty shell.
const settingsIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings',
  beforeLoad: () => {
    throw redirect({ to: '/settings/$tab', params: { tab: DEFAULT_SETTINGS_TAB } });
  },
});

const settingsTabRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/settings/$tab',
  // An unknown tab redirects to the canonical URL instead of quietly rendering
  // a different tab than the address bar claims.
  beforeLoad: ({ params }) => {
    if (!isSettingsTab(params.tab)) {
      throw redirect({ to: '/settings/$tab', params: { tab: DEFAULT_SETTINGS_TAB } });
    }
  },
  component: SettingsView,
});

const routeTree = rootRoute.addChildren([
  indexRoute,
  assetsRoute,
  collectionsRoute,
  collectionDetailRoute,
  matchRoute,
  learnRoute,
  healthRoute,
  settingsIndexRoute,
  settingsTabRoute,
]);

export const router = createRouter({
  routeTree,
  history: createHashHistory(),
  defaultPreload: 'intent',
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
