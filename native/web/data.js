// Browser stand-in of server/data.js for the packaged native web root.
// Keep this in sync with DATA_SHIM_JS in server/http/static.js.
import { getSimData } from './sim/simdata.js';
export function getData() { return getSimData() || {}; }
export function resetData() {}