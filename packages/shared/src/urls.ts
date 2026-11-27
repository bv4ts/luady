import { z } from 'zod';

/**
 * A link the website may put in an `href` (sign-in and connect links): an absolute `https:` URL only.
 * `javascript:`, `data:`, `http:` and protocol-relative strings are rejected.
 */
export const HttpsUrlSchema = z.url({ protocol: /^https$/ });
