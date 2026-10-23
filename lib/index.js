/**
 * In-preview page annotation, node half.
 *
 * Pure UI plugin: the empty `apply` exists so the plugin appears in the host
 * cordis.yml / Loader; the browser half ships via `exports["./client"]`,
 * discovered through the package.json `dsh.client` declaration.
 *
 * Everything this surface needs already lives on the client: it reads the
 * document through `remote.workspaceFiles`, draws the annotation overlay in an
 * iframe it owns, and delivers the collected notes through the session's own
 * composer. No host route, no host file access.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply() {}
