/**
 * Errors the app-wide mutation handler has already shown as a toast.
 *
 * A failed mutation with no `onError` of its own gets a toast from the
 * `MutationCache` in `TrpcProvider`. When the same mutation runs through
 * `mutateAsync`, the promise rejects with that same error object, and a caller
 * that catches it to show a toast (the confirm dialog does) would show the
 * message a second time. Marking the object lets that caller stay quiet.
 */
const toasted = new WeakSet<object>();

export function markToasted(error: unknown): void {
  if (typeof error === 'object' && error !== null) toasted.add(error);
}

export function wasToasted(error: unknown): boolean {
  return typeof error === 'object' && error !== null && toasted.has(error);
}
