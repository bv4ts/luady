import { z } from 'zod';

/**
 * The hub CSP has no 'unsafe-eval'. Zod 4 compiles object parsers with `new Function`
 * and probes for eval when the first object schema is constructed. This module must be
 * the FIRST import of src/main.tsx so it runs before @luady/shared builds its schemas.
 */
z.config({ jitless: true });
