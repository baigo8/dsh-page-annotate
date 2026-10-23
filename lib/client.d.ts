/**
 * Client half of dsh-page-annotate — a DSH loader bundle, not an importable
 * module.
 *
 * `lib/client.js` calls `window.__ModuleLoader__.load({ id, factory })` as a
 * side effect of being fetched by the shell, and the factory returns these
 * exports. Nothing outside the browser module system should `import` it.
 *
 * @module dsh-page-annotate/client
 */

/**
 * Service names the bundle needs before it may run.
 *
 * The package-name list in `package.json`'s `dsh.client.inject` is a separate
 * thing: it orders the loader rows.
 */
export declare const inject: string[];

/**
 * Register the plugin's tab type, tab body, and document-header control.
 * @param ctx - client root context.
 */
export declare function apply(ctx: unknown): void;
