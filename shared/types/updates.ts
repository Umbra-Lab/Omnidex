/**
 * Channel the main process pushes update state on, with
 * `webContents.send(UPDATE_STATE_CHANNEL, state)`.
 *
 * It is a plain IPC event rather than a tRPC subscription. That was chosen when
 * electron-trpc closed every subscription of a frame on each hash-route change,
 * which left a subscription opened at startup dead after the first navigation.
 * The same-document-navigation patch fixes that for subscriptions too; the event
 * stays because main pushes and the renderer only listens.
 */
export const UPDATE_STATE_CHANNEL = 'omnidex:update:state';
