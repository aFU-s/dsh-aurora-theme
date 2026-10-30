/**
 * dsh-aurora-theme — host half.
 *
 * This half is intentionally inert. It exists because the browser roster is
 * built from plugin rows: `@deepseek-ai/dsh-client-modules` scans the host
 * Loader's entries for packages declaring `dsh.client` and serves the matching
 * `./client` bundle at /plugins/<row-id>/client.js. A package with no row is
 * never scanned, so shipping only a client bundle would publish a plugin that
 * silently does nothing.
 *
 * Everything the plugin actually does — the alias-token override layer, the
 * wallpaper layer, the settings page — lives in the browser half
 * (src/client.js), which needs no host cooperation:
 *
 *   - the theme is read and overridden through the client `theme` service;
 *   - the wallpaper is a stylesheet the client half owns;
 *   - images chosen from disk are read with the browser's own File API, so no
 *     bytes cross the host boundary and the host file sandbox is never involved.
 *
 * If a future version needs host data (for example serving a wallpaper from a
 * path on disk, or a profile-level default), add it here and declare the
 * services it needs:
 *
 *   export const inject = ['webServer', 'fs']
 */

/** Plugin row name; must match the `name` in cordis.patch.yml. */
export const name = 'dsh-aurora-theme'

/**
 * No host-side effect: the row is mounted only to enroll the client bundle.
 */
export function apply() {}
