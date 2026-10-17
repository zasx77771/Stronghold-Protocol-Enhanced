// Browser stand-in for server/data.js. The packaged client injects its local JSON data into the
// deterministic battle simulation through /sim/simdata.js.
import { getSimData } from './sim/simdata.js';
export function getData() { return getSimData() || {}; }
export function resetData() {}
