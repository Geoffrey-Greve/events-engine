# `extensions/` — NOT DEPLOYED

Nothing in this directory ships. HubSpot's Projects framework discovers components by
`*-hsmeta.json` manifests, and there are none here; the deployed UI lives in
`../cards/` (CRM record tabs) and `../pages/` (App Home).

## How this happened, so it doesn't happen twice

`extensions/` was the original layout. Commit `d96b396` (20 Aug) migrated to the
platform-2026.03 `cards/` + `pages/` layout and wrote the manifests, but left the old
directory in place. Six feature commits afterwards edited `extensions/` — the copy with no
manifest — so the deployed Event Management card sat frozen at its 20 August state while
capacity guards (1.1), attendee contact capture (1.2), payment terms, member pricing on
staff bookings and staff notes (1.3) accumulated somewhere nobody could see them.

The duplicated `event-management` and `attendance-view` copies have been removed and their
content folded into `../cards/`. **Edit `../cards/` and `../pages/`. Anything you change in
here changes nothing.**

## What is left, and why

`onboarding/index.tsx` is the tenant onboarding UI — Stripe processor connect, the imported
Xero GST rate, payment terms, membership property mapping, webinar credentials, HubDB
provisioning, and the dynamic-page domain. It drives the worker's live
`/api/v1/manage/onboarding/*` routes, and **it has no deployed counterpart**: `../pages/Home.tsx`
is the App Home page (event list + manual booking) and contains none of it.

**Shipping it is deliberately deferred** — onboarding is marketplace-track work (see
`docs/ui-and-onboarding-spec.md`), and Weld is a manually-provisioned tenant, so nothing is
blocked by it flowing later. It is kept rather than deleted so the work is there when the
time comes. To ship it, it needs to become the app's **settings extension**: the projects
framework recognises a singular `settings` sub-component (see `SETTINGS_KEY` in
`@hubspot/project-parsing-lib`), which means moving this file to `src/app/settings/` with a
`*-hsmeta.json` beside it. The manifest's exact `config` shape could not be confirmed from
the pinned tooling, so it has deliberately not been guessed — check it against current
HubSpot docs before wiring it up. A second `page` component is not an option: pages are
singular per app and App Home is taken.

`shared/use-extension-props.ts` exists only because `onboarding/index.tsx` imports it. It is
a copy of `../cards/shared/use-extension-props.ts`; keep the two in step until onboarding
moves, at which point this directory should go entirely.
