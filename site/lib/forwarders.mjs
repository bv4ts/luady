import { scriptOnlyPolicy } from './csp.mjs';
import { withBase } from './links.mjs';
import { esc } from './meta.mjs';
import { absoluteUrl } from './site-url.mjs';

/**
 * A page left at an old address (`rooms.html`) that sends the visitor on to the new one (`/luady/docs/rooms/`), keeping
 * any #section of the old link. A one-line script does the forwarding (so the #section survives); a refresh tag does it
 * without JavaScript, and a plain link is there if both are off. Search engines are told the new address is the one.
 */
export function forwarderPage({ basePath, siteUrl, newPath, title }) {
  const target = withBase(basePath, newPath);
  const script = `location.replace(${JSON.stringify(target)}+location.hash)`;
  const canonical = siteUrl === null ? '' : `<link rel="canonical" href="${esc(absoluteUrl(siteUrl, newPath === '' ? './' : newPath))}">\n`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${scriptOnlyPolicy([script])}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} has moved</title>
${canonical}<script>${script}</script>
<meta http-equiv="refresh" content="0; url=${esc(target)}">
</head>
<body>
<p>This page has moved to <a href="${esc(target)}">${esc(title)}</a>.</p>
</body>
</html>
`;
}
