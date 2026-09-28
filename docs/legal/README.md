# Legal drafts (P0 #4) — READ THIS FIRST

> **These are DRAFTS, not legal advice, and are not ready to publish or sign.**
> They were written by an AI assistant from the product's code and README. They
> must be reviewed, completed and adapted by a qualified lawyer in each
> jurisdiction you sell into before any customer sees them. A wrong or
> over-promising ToS/Privacy Policy/DPA can create liability that a code bug
> usually cannot.

| File | Purpose |
|---|---|
| `terms-of-service.md` | Customer-facing agreement for the hosted service |
| `privacy-policy.md` | What personal data the service handles and why |
| `data-processing-agreement.md` | Controller/processor terms (GDPR-style) for business customers |

## What is grounded in the code, and what is not

Statements about **what the product does** were taken from the repository at the
time of writing (e.g. provider keys are forwarded and never stored; PII redaction
is on by default and regex-based; tenant offboarding has an export-then-purge
flow; passwords are scrypt-hashed). **Re-verify each before publishing** — code
changes, and a legal document that describes behaviour the product no longer has
is worse than none.

Anything in `[SQUARE BRACKETS]` is a fact only *you* can supply (legal entity,
address, governing law, prices, contacts, hosting region, subprocessors).

## Open questions a lawyer (and you) need to answer

1. **Who is the legal entity** contracting with customers, and where is it
   established? This drives governing law, tax and which regimes apply.
2. **Which privacy regimes apply?** Likely candidates depending on where
   customers and their end-users are: GDPR/UK GDPR (EU/UK customers), India's
   DPDP Act 2023 (check the current status of its Rules), CCPA/CPRA (California).
   I have not asserted compliance with any of them.
3. **Data retention.** There is currently **no automatic expiry on usage
   records** (`usage_events`); only backups are pruned (default: keep 7) and
   tenant data is purged after offboarding. Decide a retention period and build
   it, or the policy must say "kept until the customer deletes it / offboards".
4. **Prompt/response content.** Proxy usage rows store metadata (model, tokens,
   cost, tags), not prompt text. But the ingest webhook stores the (PII-redacted)
   payload, and the response/semantic caches and shadow-test features may store
   prompt/response content. **Confirm exactly what each stores** and edit the
   Privacy Policy §2 and DPA Annex I to match.
5. **PII redaction is regex-based best effort**, not a guarantee. The drafts say
   so; do not let sales material claim otherwise.
6. **Subprocessors.** The drafts list the categories the code implies (hosting,
   Postgres, Stripe, SMTP, LLM providers as customer-directed). Fill in the real
   vendors and regions.
7. **Security claims.** The DPA lists technical measures visible in code. Do not
   claim SOC 2, ISO 27001, penetration testing, or encryption at rest unless
   they are actually true — the gap analysis lists SOC 2 and a pen test as open.
8. **Service levels.** No uptime SLA is offered in the draft. The load test
   (`docs/load-test-results.md`) shows capacity limits; do not promise more than
   you have measured.
9. **Liability cap, indemnities, governing law, dispute forum** are deliberately
   left as placeholders with a conservative default — these are negotiated
   commercial/legal decisions.
10. **Children / sensitive data / regulated data (health, financial).** The draft
    prohibits sending regulated data unless separately agreed. Decide if that is
    your intended position.
