# Sharing the app over a tunnel

One public URL serves the whole thing. The web app already proxies the API's
path prefixes to the API process, so a single hostname covers the pages and the
API, and the browser only ever talks to one origin. That is not a shortcut: the
free ngrok plan allows one agent, and tunnelling the API separately would need a
second one and would reintroduce the CORS problem the proxy exists to avoid.

    browser ──► https://<domain>  ──►  :3001 web  ──►  :3000 api
                                        (server-side proxy)

## Once

    ngrok config add-authtoken <token>     # from dashboard.ngrok.com

The authtoken is the one thing the script cannot supply for you.

## Every time — three terminals

    pnpm dev:api      # API  on 3000
    pnpm dev:web      # web  on 3001
    pnpm tunnel       # ngrok on the reserved domain

Order matters for the first two. The API's port is fixed at 3000 and the proxy
hardcodes it, so starting the web first lets it take that port and proxy to
itself — which surfaces as `Internal Server Error` on every API call, not as a
port conflict.

## The static domain

`pnpm tunnel` runs with or without one. Without, you get a random hostname and
everything works except DigiLocker consent, which only redirects to a URL
registered against the app.

Claim the free one at <https://dashboard.ngrok.com/domains>, then put the name
in `.env` as `NGROK_DOMAIN=<name>.ngrok-free.app`. The script reads it from
there and writes the hostname into the other three settings itself, so they
cannot drift apart.

Note that a domain reserved under someone else's account cannot be borrowed —
binding it fails with `ERR_NGROK_320`, which is what the hostname inherited with
this `.env` does.

## Why the domain is reserved rather than random

DigiLocker only redirects to a URL registered against the app. A fresh ngrok
hostname on every run would mean re-registering it on every run, and the consent
step would fail until you did. The domain lives in `DIGILOCKER_REDIRECT_URL` and
the tunnel script reads it from there, so the two cannot drift apart.

Three settings must agree with the domain. The script prints them on startup:

| Where | Setting |
|---|---|
| `.env` | `DIGILOCKER_REDIRECT_URL` = `https://<domain>/identity/callback` |
| `.env` | `CORS_ORIGINS` includes `https://<domain>` |
| `apps/web/.env.local` | `TUNNEL_HOST` = `<domain>` |

`TUNNEL_HOST` is the one that is easy to miss. Next 15 rejects cross-origin dev
requests from a host it was not told about, and a tunnel is exactly that — the
page loads and every chunk after it fails, which reads as a blank screen rather
than a configuration problem.

## Testing both sides

Both parties are now the same account by design: one company name, one
DigiLocker verification, one World ID enrolment, one wallet. So two people
testing a payment need **two browsers with two different MetaMask accounts**,
each running its own onboarding, not one browser switching views.

The payer/payee switch in the sidebar changes which screens are listed. It does
not change who you are.

## What still has to be real

- **Hedera testnet HBAR** in both wallets, for gas.
- **The payment token** in the payer's wallet — they fund the escrow themselves.
- **World ID** is enforced when raising a payment, optional when accepting one.

## The ngrok warning page

Free-plan tunnels show an interstitial in front of HTML traffic. Every visitor
clicks through it once; a cookie then suppresses it for that domain for 7 days.

**There is no server-side header that removes it.** The documented bypass is the
`ngrok-skip-browser-warning` request header, which only helps clients that can
set headers — a person typing the URL cannot set one on the first navigation. I
tested injecting it with an agent traffic policy and it does not work: ngrok
evaluates the interstitial before policy actions run, so the page still appears.

What that header DOES protect is everything after the first load. The app sets
it on every request it makes, so no API call, World ID signature or verification
can ever receive the warning page where it expects JSON — which would otherwise
surface as a parse error pointing at entirely the wrong thing.

Removing the page itself needs one of:

- clicking through once per visitor per 7 days (what you have now),
- a paid ngrok plan, which drops the interstitial,
- or a proxy in front that adds the header, which is another service to run.
