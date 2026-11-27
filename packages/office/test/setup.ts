import { setManagerName, setOwnerZone } from '@luady/shared';

// Every package's tests run in one fixed owner zone that is not UTC, so zone mistakes show, with the default name.
setOwnerZone('Etc/GMT-4');
setManagerName('Luady');
