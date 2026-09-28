> **DRAFT — NOT LEGAL ADVICE. Not for publication or signature until reviewed by qualified counsel.** See `README.md` in this folder. This is a GDPR-style controller→processor template; whether it is the right instrument, and which transfer mechanism applies, depends on the parties' locations. Items in [BRACKETS] must be completed.

# Data Processing Agreement — FinOps Guard

This DPA forms part of the agreement (the "Agreement") between **[LEGAL ENTITY NAME]** ("Processor", "we") and the customer named in it ("Controller", "you"), and applies where we process personal data on your behalf in providing the service.

## 1. Definitions
"Personal Data", "processing", "controller", "processor", "data subject" and "personal data breach" have the meanings in the applicable data-protection law ("Data Protection Law"), which includes [GDPR / UK GDPR / other — COUNSEL].

## 2. Roles and scope
You are the controller of Personal Data contained in Customer Data; we are your processor. Details of the processing are in **Annex I**. We process Personal Data only to provide the service and on your documented instructions (the Agreement, this DPA, and your configuration and use of the service), unless law requires otherwise, in which case we will tell you first where permitted. We will tell you if we think an instruction infringes Data Protection Law.

## 3. Your responsibilities
You are responsible for having a lawful basis to send Personal Data through the service, for the content you send, and for your configuration choices — including whether PII redaction is enabled or bypassed for a key. You acknowledge that **PII redaction is best-effort** and does not guarantee removal of all personal data.

## 4. Confidentiality and personnel
We ensure people authorised to process Personal Data are bound by confidentiality and access it only as needed.

## 5. Security
We implement appropriate technical and organisational measures. As of the date of this draft these include (**Annex II** — re-verify before signing): salted `scrypt` password hashing; role-based access control; per-tenant database-schema isolation in the hosted service; hashed, single-use, expiring password-reset and email-verification tokens; rate limiting on authentication endpoints; automatic quarantine of API keys showing compromise signals; an audit log of administrative actions; automated backups with tested restore. [Do not add encryption at rest, SOC 2, ISO 27001 or penetration-test claims unless true.]

## 6. Subprocessors
You give general authorisation for the subprocessors in **Annex III**. We will give [30] days' notice of additions or replacements; you may object on reasonable data-protection grounds, and if unresolved either party may terminate the affected service. We impose data-protection obligations on subprocessors no less protective than these and remain liable for their performance.

**AI model providers are not our subprocessors.** They receive requests because you directed the service to forward them, using your own provider keys and agreement; you are responsible for that relationship.

## 7. Assistance
Taking into account the nature of processing, we will reasonably assist you with data-subject requests (the service includes workspace export and deletion tools), and with security, breach-notification, impact-assessment and regulator-consultation obligations. We may charge reasonable costs for assistance beyond normal service functionality. If a data subject contacts us directly about your data we will refer them to you.

## 8. Personal data breach
We will notify you **without undue delay [and within 72 hours — COUNSEL]** after becoming aware of a personal data breach affecting your Personal Data, with the information reasonably available to help you meet your own obligations, and will take reasonable steps to contain and remediate it.

## 9. International transfers
[COUNSEL: state the transfer mechanism — e.g. adequacy, or Standard Contractual Clauses / UK Addendum incorporated by reference with the module for controller→processor — and any additional measures. Complete where data and subprocessors are located.]

## 10. Return and deletion
On termination we make a workspace export available and then delete Personal Data after [X] days, unless law requires retention. Backups are overwritten on their normal rotation (most recent [7] kept). Usage records have no automatic expiry while a workspace is active [DECIDE/BUILD retention — see README].

## 11. Audits
On reasonable notice and no more than [once a year, unless required by a regulator or following a breach] we will provide information necessary to demonstrate compliance and allow for audits by you or your auditor, under confidentiality and without disrupting other customers. [Where we hold an independent audit report, providing it may satisfy this.]

## 12. Liability and order of precedence
Liability under this DPA is subject to the limitations in the Agreement [COUNSEL: check whether data-protection liability is carved out or super-capped]. If this DPA conflicts with the Agreement on the processing of Personal Data, this DPA prevails.

---

## Annex I — Details of processing
| | |
|---|---|
| **Subject matter** | Provision of the FinOps Guard AI-spend metering and control service |
| **Duration** | Term of the Agreement plus the deletion period in §10 |
| **Nature / purpose** | Receiving, forwarding, metering, attributing, storing and reporting on AI API requests; account and access management; alerts; optional caching, model comparison and governance features |
| **Categories of data subjects** | Your personnel who use the dashboard; individuals whose data appears in prompts, tags, customer or user identifiers you send [CONFIRM] |
| **Types of personal data** | Account data (username, optional email, role); usage metadata and tags (which may include customer/user identifiers you supply); IP address in rate-limit audit records; [CONFIRM: content of ingested payloads after redaction, and cached/shadow-test prompts and responses if those features are enabled] |
| **Special-category data** | Not intended; prohibited unless separately agreed in writing |
| **Frequency** | Continuous |

## Annex II — Technical and organisational measures
See §5. [Keep this list factual and current.]

## Annex III — Authorised subprocessors
| Subprocessor | Service | Location |
|---|---|---|
| [Cloud host] | Application hosting | [REGION] |
| [Database host] | Managed PostgreSQL | [REGION] |
| [Stripe] | Payments (billing contacts) | [REGION] |
| [Email/SMTP provider] | Transactional email | [REGION] |
