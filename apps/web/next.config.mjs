/** @type {import('next').NextConfig} */

// The API's top-level path prefixes. Anything under these is proxied to the
// API process; everything else is served by Next.
//
// WHY PROXY AT ALL. The free ngrok plan allows one agent, and two things need
// a public URL: the browser (so a counterparty can open the console from
// another machine) and the CRE DON (which calls the vendor-lookup and
// verdict-callback endpoints at the apiBaseUrl baked into the deployed
// workflow). Proxying lets one domain serve both, which also means the console
// can use relative paths and stop caring which host it is on.
//
// NOTE the absence of "api": Next's own routes live at /api/world-id/*, and
// proxying that prefix would break the rp-signature call the widget needs.
const API_PREFIXES = [
  "health",
  "dev",
  "vendors",
  "payments",
  "world-id",
  "internal",
  "evidence",
  "exceptions",
  "approvals",
  "securities",
  "settlement",
  "swagger",
];

// `next build` rejects a rewrite destination that does not start with "/",
// "http://" or "https://", and fails the whole build with "Invalid rewrites
// found" listing every route — which reads as a bug in this file rather than a
// missing scheme in an environment variable.
//
// So a qualified bare host is accepted and given one. A bare NAME is not:
// Render's `fromService … property: host` hands over "securtxn-api", which
// resolves only on its private network, and prefixing that would move the
// failure from the build to every API call at runtime (ENOTFOUND), where the
// pages still render and only the data is missing.
function normaliseOrigin(value) {
  if (!value) return "http://127.0.0.1:3000";
  if (/^https?:\/\//.test(value)) return value;
  if (!value.includes(".")) {
    throw new Error(`API_ORIGIN must be a URL or a qualified host, got "${value}"`);
  }
  return `https://${value}`;
}

const API_ORIGIN = normaliseOrigin(process.env.API_ORIGIN);

/**
 * Hosts allowed to reach the dev server from another origin.
 *
 * Next 15 refuses cross-origin dev requests unless the host is listed, which is
 * exactly what a tunnel is: the browser asks for the ngrok hostname, and its
 * requests for /_next/* arrive with that Origin. Without this the page loads
 * and every chunk after it fails, which reads as a blank screen rather than as
 * a configuration problem.
 *
 * Set `TUNNEL_HOST` to the tunnel's hostname, no scheme. Only ever a dev
 * concern — a production build serves its own assets.
 */
const TUNNEL_HOST = process.env.TUNNEL_HOST;

export default {
  reactStrictMode: true,
  ...(TUNNEL_HOST ? { allowedDevOrigins: [TUNNEL_HOST] } : {}),
  // No PII may reach the client bundle. Only NEXT_PUBLIC_* is exposed, and the
  // only public value this app needs is the World App id (§4.6).

  // @cp/shared-types is consumed as TypeScript source, not a build artefact,
  // so Next has to compile it rather than treat it as an external package.
  transpilePackages: ["@cp/shared-types"],

  async rewrites() {
    const proxied = API_PREFIXES.flatMap((prefix) => [
      { source: `/${prefix}`, destination: `${API_ORIGIN}/${prefix}` },
      { source: `/${prefix}/:path*`, destination: `${API_ORIGIN}/${prefix}/:path*` },
    ]);

    // beforeFiles, NOT the default.
    //
    // A bare `rewrites()` array is `afterFiles`, which runs only when no page
    // matched — and this app has pages at /vendors, /payments, /approvals,
    // /exceptions and /evidence. Those shadowed the proxy silently: the API
    // call returned 200 with Next's HTML, JSON.parse produced a string, and the
    // first visible symptom was an `undefined` id three steps later.
    //
    // Those pages are all `return null` placeholders, so nothing is lost by
    // giving the API the prefix. If one of them is ever built out, it needs a
    // path that does not collide with the API.
    //
    // THAT IS WHY THE DASHBOARD IS AT /app. It was going to be /payments — the
    // landing page's "Launch App" pointed there — and it would have rendered
    // the API's JSON with no error anywhere. Adding any prefix beginning with
    // "app" to the list above would take the whole dashboard down the same
    // silent way.
    return { beforeFiles: proxied };
  },

  webpack: (config) => {
    // That package is written for NodeNext, where a relative import of a TS
    // file must be spelled with a `.js` extension. Next's bundler resolves
    // those literally, finds no `primitives.js` next to `primitives.ts`, and
    // fails the whole route with "Module not found".
    //
    // The alias below teaches it the NodeNext convention. Without it the only
    // alternative is a second copy of the EIP-712 struct definitions in this
    // app — which is exactly the drift the shared package exists to prevent,
    // and it fails silently: a reordered field yields a valid signature that
    // recovers to the wrong address.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      ".js": [".ts", ".tsx", ".js"],
    };
    return config;
  },
};
