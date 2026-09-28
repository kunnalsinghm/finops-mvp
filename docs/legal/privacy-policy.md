> **DRAFT — NOT LEGAL ADVICE. Not for publication until reviewed by qualified counsel.** See `README.md` in this folder. Items in [BRACKETS] must be completed; statements about product behaviour must be re-verified against the code before publishing.

# Privacy Policy — FinOps Guard

**Effective date:** [DATE]  **Operator ("we", "us"):** [LEGAL ENTITY NAME], [REGISTERED ADDRESS]  **Contact:** [PRIVACY EMAIL]

## 1. What this service is, and our two roles

FinOps Guard is a proxy and dashboard that sits between your applications and AI
model providers (such as OpenAI and Anthropic) to measure, attribute and control
AI spend.

- For **account and billing data** about the people who use the dashboard, we are
  the **controller** (we decide why and how it is used).
- For **usage data and any content that passes through the service on your behalf**,
  you are the controller and we are your **processor**. Those terms are in the
  [Data Processing Agreement](data-processing-agreement.md).

## 2. Data we handle

| Category | Examples | Why |
|---|---|---|
| **Account data** | Username, role, optional email address, password (stored only as a salted `scrypt` hash), email-verification and password-reset tokens (stored only as hashes, single-use, expiring) | To let you sign in, verify your email and recover your account |
| **Usage / metering data** | Timestamp, provider, model, token counts, computed cost, the API key ID used, and tags you supply (team, environment, feature, customer, project, cost centre), self-reported client region, workload type | To attribute, report and control spend — this is the core service |
| **Ingested events** | Payloads you send to our ingest endpoint, stored after automated PII redaction | To record usage from systems that don't use the proxy |
| **Cached or test content** | [CONFIRM: if response/semantic caching or shadow testing is enabled, prompts and model responses may be stored to serve repeat requests or compare models] | Caching and model comparison features you switch on |
| **Operational records** | Audit log (who did what, when), alert log, and IP address where a rate-limit event is recorded | Security, abuse prevention, accountability |
| **Billing data** | Handled by our payment processor [Stripe]; we receive plan and subscription status, not full card numbers | To charge for the service |

**Your model provider keys are forwarded to the provider to make each request and are not stored by us.**

**Prompts and responses.** Proxy usage records contain metadata about a request,
not the text of your prompts. Text passes through in transit to the provider you
chose, under your own agreement with that provider. [CONFIRM against the ingest,
cache and shadow-test behaviour before publishing.]

**PII redaction.** By default the service automatically detects and masks common
patterns (email addresses, phone numbers, national ID-style numbers, payment card
numbers, IP addresses) before a request is forwarded or stored. This is
pattern-based and **will miss some personal data and occasionally mask
non-personal data**. It is a safeguard, not a guarantee; you remain responsible
for what you send. A key can be granted permission to disable redaction; if you
do, the data is sent and stored unmasked.

## 3. What we do not do

We do not sell personal data. We do not use the content passing through the
service to train AI models. [CONFIRM both are true for your business.]

## 4. Legal bases (where GDPR/UK GDPR applies)

Contract (providing the service you signed up for); legitimate interests
(security, abuse prevention, service improvement); consent where we ask for it
(e.g. optional communications); legal obligation (tax, accounting).
[Counsel to confirm and add DPDP/other-regime equivalents.]

## 5. Who we share data with

We use service providers ("subprocessors") to run the service, under written terms:

| Provider | Purpose | Location |
|---|---|---|
| [Cloud host] | Application hosting | [REGION] |
| [Postgres / database host] | Database | [REGION] |
| [Stripe] | Payment processing | [REGION] |
| [Email/SMTP provider] | Verification, password-reset and alert emails | [REGION] |

**AI model providers** (e.g. OpenAI, Anthropic) receive your requests because *you
directed the service to send them*; their handling is governed by your own
agreement with them, not this policy.

We may disclose data if legally required, or to protect rights and safety.

## 6. International transfers

[COUNSEL: describe safeguards, e.g. Standard Contractual Clauses / adequacy, based on where you and your subprocessors operate.]

## 7. Retention

- **Account data:** kept while your account exists.
- **Usage records:** [DECIDE — currently retained until you delete them or your workspace is offboarded; there is no automatic expiry].
- **Backups:** the most recent [7] backups are kept and older ones are pruned automatically.
- **Offboarding:** when a workspace is closed we make an export available and permanently delete the workspace's data after a [X]-day grace period. Backups age out on the schedule above.
- **Password-reset links** expire after 1 hour; **email-verification links** after 24 hours.

## 8. Security

Passwords are salted and hashed; access is role-based; each customer's data in
the hosted service is held in a separate database schema; databases are backed
up and restores are tested. No system is perfectly secure. [Do NOT add claims
about encryption at rest, SOC 2, ISO 27001 or penetration testing unless true.]
If we become aware of a breach affecting your data we will notify you [without
undue delay / within 72 hours — COUNSEL TO CONFIRM].

## 9. Your rights

Depending on where you live you may have rights to access, correct, delete,
restrict or object to processing of, and receive a copy of your personal data,
and to withdraw consent or complain to a regulator. Contact [PRIVACY EMAIL].
If your data is in a workspace run by your employer or another customer of ours,
please contact them first — they control that data.

## 10. Children

The service is for businesses and is not directed at children under [16/18].

## 11. Changes

We will post changes here and, for material changes, notify account holders
[by email / in the dashboard] at least [30] days ahead.

## 12. Contact

[LEGAL ENTITY NAME], [ADDRESS], [PRIVACY EMAIL]. [DATA PROTECTION OFFICER / EU/UK REPRESENTATIVE, if required.]
