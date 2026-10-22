# Add a tRPC procedure

This guide adds a read procedure end to end. The worked example returns the total size on disk of one collection.

## 1. Write the query in the repo layer

All SQL lives in `electron/main/db/repos/`. Add the function to the file that owns the domain — here, `collections.ts`:

```ts
export function collectionSizeBytes(db: Database, collectionId: number): number {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(a.file_size), 0) AS total
         FROM collection_items ci
         JOIN assets a ON a.id = ci.asset_id
        WHERE ci.collection_id = ?`,
    )
    .get(collectionId) as { total: number };
  return row.total;
}
```

The function takes `Database` first and knows nothing about IPC. That is what makes it callable from a CLI operation and testable without a router.

## 2. Add the input schema

Zod schemas live in `electron/main/trpc/schemas.ts`:

```ts
export const collectionIdInput = z.object({ collectionId: z.number().int().positive() });
```

Reuse an existing schema if one fits. Do not inline a schema in the router.

## 3. Add the procedure

In `electron/main/trpc/routers/collections.ts`:

```ts
sizeBytes: publicProcedure
  .input(collectionIdInput)
  .query(({ input }) => collectionsRepo.collectionSizeBytes(openDatabase(), input.collectionId)),
```

Use `.query()` for reads and `.mutation()` for writes. The distinction drives caching in the renderer, so getting it wrong means a write gets cached or a read never does.

## 4. Call it

```tsx
const { data: sizeBytes, isPending } = trpc.collections.sizeBytes.useQuery({ collectionId });
```

No client-side type declaration is needed. The renderer imports only the `AppRouter` type, so the return type flows through.

## 5. Invalidate on mutation

If you added a mutation, invalidate what it affects:

```tsx
const utils = trpc.useUtils();
const addAssets = trpc.collections.addAssets.useMutation({
  onSuccess: () => {
    utils.collections.get.invalidate({ collectionId });
    utils.collections.sizeBytes.invalidate({ collectionId });
  },
});
```

```admonish warning title="Stale data after a mutation is an invalidation bug"
The usual symptom is a number that only updates after a manual refresh. Invalidate every query whose result the mutation changed, including derived counts — not just the list you were looking at.
```

## 6. Test the repo function

Test the repo layer, not the router. It is where the logic is, and it needs no IPC harness:

```ts
it('sums file_size across a collection', () => {
  const db = createTestDb();
  // ... seed assets and collection_items
  expect(collectionSizeBytes(db, 1)).toBe(300);
});
```

Fixtures live in `electron/main/db/repos/__tests__/fixtures/test-db.ts` and declare only the schema slice they need.

## 7. Verify

```bash
pnpm check && pnpm lint && pnpm test:run
```

## Rules

- **No SQL outside `db/repos/`.** A query in a router cannot be reached by the CLI and cannot be unit-tested.
- **No `ipcRenderer.invoke` in renderer code.** Extend the router instead.
- **Return errors, do not throw them,** when the renderer must act on the detail. The superjson patch bypasses tRPC's `errorFormatter`, so custom `data` on a thrown error is silently dropped. See [IPC and the tRPC layer](../subsystems/ipc.md).

## Next steps

- [tRPC API](../reference/trpc-api.md) — the existing procedure surface
- [Write a migration](write-a-migration.md) — if your query needs a new column
