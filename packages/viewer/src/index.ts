/**
 * @orcareplay/viewer — renders an Orca trace into one self-contained HTML file.
 *
 * The whole package exists to satisfy one constraint: the output opens from file://, offline,
 * on a machine with nothing installed. No CDN, no webfont, no runtime dependency, no fetch.
 */

export { CLIENT_SOURCE } from './client/main.js';
export * from './bundle.js';
export * from './css.js';
export * from './export.js';
export * from './html.js';
export * from './render.js';
export * from './serve.js';
export * from './trace-dir.js';
