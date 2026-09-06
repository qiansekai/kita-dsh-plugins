//#region lib/index.js
/**
 * kita-reconnect-on-visible, host half. Pure client plugin: the empty apply
 * exists so the plugin appears in the host cordis.yml / Loader (load and
 * lifecycle follow the host; the browser half ships via exports["./client"],
 * discovered through the package.json dsh.client declaration).
 */
/** Host plugin body — no host-side behavior for this plugin. */
function apply() {}
//#endregion
export { apply };
