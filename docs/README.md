# event-engine developer documentation

Start here. This folder holds two kinds of document, and mixing them up wastes time:

**Reference docs** describe the code as it is now. They are written from the source and
should be updated in the same commit as the code they describe.

| Doc | Read it when |
| --- | --- |
| [architecture.md](architecture.md) | You are new, or you need the module map and why the layers are split the way they are |
| [getting-started.md](getting-started.md) | You want the repo running locally, migrations applied, tests green |
| [data-model.md](data-model.md) | You are touching D1, the Durable Object state, or KV keys |
| [api-reference.md](api-reference.md) | You are calling the worker or adding an endpoint |
| [flows.md](flows.md) | You need to follow a booking, refund, waitlist, voucher or attendance path end to end |
| [operating-workflows.md](operating-workflows.md) | You need the human workflow: who creates an event, who books, who decides, and how to test it on staging |
| [outbox-queues-cron.md](outbox-queues-cron.md) | You are adding a HubSpot side effect, a queue job or a cron task |
| [hubspot-integration.md](hubspot-integration.md) | You are working on OAuth, deals, invoices, GST, Marketing Events or webhooks |
| [webinar-providers.md](webinar-providers.md) | You are adding or debugging an online-event provider |
| [security.md](security.md) | You are touching auth, signing, encryption or tenant isolation |
| [testing.md](testing.md) | You are writing tests, or a test is failing and you do not know why |
| [contributing.md](contributing.md) | You are about to open a PR, add a migration or run CI locally |

**Specs and briefs** capture design intent at a point in time. They explain why decisions
were made and are useful context, but the code and the reference docs win where they differ.

| Doc | What it is |
| --- | --- |
| [event-worker-spec.md](event-worker-spec.md) | Original worker build brief. Some schema and file names have since moved on |
| [deploy-config.md](deploy-config.md) | Migration and wrangler config notes, plus the renumbering runbook. The consolidated schema block is reference only |
| [tenant-provisioning-spec.md](tenant-provisioning-spec.md) | Multi-tenant install and provisioning design (data vs code) |
| [ui-and-onboarding-spec.md](ui-and-onboarding-spec.md) | UI surface inventory, App Cards, marketplace install and billing flow |
| [ops-runbook.md](ops-runbook.md) | Per-tenant onboarding checklist and incident playbook |
| [listing-submission.md](listing-submission.md) | HubSpot marketplace listing package |
| [weld-feature-brief.md](weld-feature-brief.md) | Phase 18 implementation brief for the first tenant |

Repo-level context lives in [CLAUDE.md](../CLAUDE.md) and [AGENTS.md](../AGENTS.md): the
invariants, HubSpot gotchas and business rules. Those are the rules; this folder is the map.

## The five-minute version

A multi-tenant Cloudflare Worker that adds atomic seat capacity, reservation holds,
waitlist, ticketing and check-in to HubSpot CMS event sites. HubSpot stays the system of
record for contacts, Marketing Events, deals, invoices and payments, and renders the whole
front end. The worker owns only what HubSpot Professional cannot do.

Four things you cannot break without introducing a bug:

1. All seat math goes through the `EventCapacity` Durable Object. D1 never decrements a
   capacity counter on the hot path.
2. Seats commit on payment confirm, never on reserve. A reserve is a 15-minute TTL hold.
3. Every HubSpot side effect is written to the `outbox` table in the same D1 batch as the
   state change that caused it, then drained by the queue.
4. Every row carries `portal_id`, and every token or secret is resolved per tenant.

The rest of the reasoning is in [architecture.md](architecture.md).
