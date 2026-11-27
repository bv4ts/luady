import { setManagerName, setOwnerZone } from '@luady/shared';
import { cleanup, configure } from '@testing-library/react';
import { afterEach } from 'vitest';

// One fixed owner zone that is not UTC, so zone mistakes show, with the default name. The browser's own zone (which the
// page uses while no zone is stored) is the same fixed zone, so no test depends on the zone of the machine it runs on.
process.env.TZ = 'Etc/GMT-4';
setOwnerZone('Etc/GMT-4');
setManagerName('Luady');

// `findBy…` and `waitFor` give up after one second by default: too little while a lazy page loads on a busy machine.
configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
  cleanup();
});
