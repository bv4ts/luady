import { setManagerName, setOwnerZone } from '../src/pure/index.js';

// Every package's tests run in one fixed owner zone that is not UTC, so zone mistakes show, with the default name.
setOwnerZone('Etc/GMT-4');
setManagerName('Luady');
