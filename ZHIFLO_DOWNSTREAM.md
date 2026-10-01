# ZhiFlo LibreChat downstream policy

This fork tracks LibreChat-AI/LibreChat and intentionally keeps the ZhiFlo delta small.

## Downstream changes

- ZhiFlo AI product title and browser/PWA branding.
- ZhiFlo brand mark on the authentication UI.
- ZhiFlo-owned release image at ghcr.io/zhiflo/librechat.

Authentication remains standard LibreChat OpenID Connect. ZhiFlo-specific user, quota,
subscription, API-key, and billing state belongs to ZhiFlo API, not this fork.

## Upstream sync

The zhiflo-upstream-sync workflow runs daily and can also be dispatched manually.
It fetches LibreChat-AI/LibreChat:main, merges clean upstream updates, runs static checks,
client/API tests and a frontend build, then publishes a multi-architecture image. A merge
conflict or failed test blocks publishing and opens an issue instead of force-merging.
