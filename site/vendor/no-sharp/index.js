// The Luady site exports static files with image optimisation off (images.unoptimized in next.config.mjs), so Next.js
// never needs sharp. This package takes its place in the lockfile, which keeps sharp's LGPL image libraries out of the
// install. If something does load it, it says why it is missing instead of failing later in a confusing way.
throw new Error('sharp is not installed in the Luady site: image optimisation is off (images.unoptimized), so it is not needed.');
