> **DRAFT — NOT LEGAL ADVICE. Not for publication until reviewed by qualified counsel.** See `README.md` in this folder. Items in [BRACKETS] must be completed. Liability, indemnity, governing-law and dispute clauses are conservative placeholders for counsel to negotiate.

# Terms of Service — FinOps Guard

**Effective date:** [DATE]  **Provider:** [LEGAL ENTITY NAME], [ADDRESS] ("we", "us")  **Customer:** the organisation or individual that creates a workspace ("you")

By creating a workspace or using the service you agree to these terms. If you accept on behalf of an organisation, you confirm you have authority to bind it.

## 1. The service

FinOps Guard is a proxy and dashboard that sits between your applications and AI model providers to meter, attribute, alert on and control AI spend. It also offers optional features such as caching, model comparison ("shadow testing"), tool-call governance and PII redaction.

**We are not the model provider.** Requests are forwarded to providers you choose (e.g. OpenAI, Anthropic) using **your own provider keys**, under **your own agreement** with them. Their terms, pricing, availability and outputs are outside our control.

## 2. Accounts and access

- You must give accurate information and keep credentials and API keys confidential. You are responsible for all activity under your workspace, including by keys you create or grant privileges to (for example background-workload or PII-redaction-bypass rights).
- Tell us promptly at [SECURITY EMAIL] if you suspect a key or account is compromised. The service may automatically restrict ("quarantine") a key showing signs of compromise; you acknowledge such automated action can occasionally affect legitimate traffic.
- You may not share accounts or resell access except as we agree in writing.

## 3. Your responsibilities and acceptable use

You must not:
- send unlawful content, or infringe others' rights, or use the service to violate a model provider's terms;
- send **regulated or special-category data** (for example health records, payment card data, government IDs, children's data) unless we have agreed in writing that the service is suitable;
- attempt to probe, overload, bypass or reverse-engineer the service, its rate limits, budgets or security controls, or use it to attack others;
- use it in a way that could cause unreasonable load on other customers.

**PII redaction is a best-effort safeguard, not a guarantee.** It is pattern-based, will miss some personal data and may mask some non-personal data. You remain responsible for what you send and for having a lawful basis to send it.

## 4. Cost figures, budgets and limits are estimates

Costs shown or enforced by the service are **computed from token counts and price tables** and are estimates. They may differ from the provider's invoice (for example due to price changes, unpriced models, rounding, or usage we could not observe). Budget and quota controls act on usage recorded *so far*, so a request in flight can exceed a limit. **You must not rely on the service as your only financial control or as an invoice.** We are not liable for spend that exceeds a budget or for a provider's charges.

## 5. Fees, trials and taxes

Fees are as shown at sign-up or in your order: [PRICING / PLAN DESCRIPTION]. Trials [last X days / are limited to Y] and may end automatically. Fees are [billed in advance / monthly], are non-refundable except where law requires or we state otherwise, and exclude taxes. We may change prices on [30] days' notice. Payments are processed by [Stripe]; their terms apply to payment processing. If payment fails we may suspend the workspace after notice.

## 6. Your data

You own your data ("Customer Data"). You grant us the limited right to process it to provide, secure and support the service. Our handling of personal data is described in the [Privacy Policy](privacy-policy.md) and, for business customers, the [Data Processing Agreement](data-processing-agreement.md), which forms part of these terms. We do not use Customer Data to train AI models [CONFIRM].

You can export your workspace data at any time before or during offboarding. After termination we make an export available and delete workspace data after [X] days (backups age out on their normal schedule).

## 7. Our intellectual property

We and our licensors own the service and its software. We grant you a non-exclusive, non-transferable right to use it during the term. Feedback you give may be used without obligation.

## 8. Availability and support

We aim to keep the service available but **provide it without an uptime commitment** [unless a separate written SLA applies]. The service may have capacity limits (for example a default per-key rate limit) and may be interrupted for maintenance or by events beyond our control. Support: [CHANNEL / HOURS].

## 9. Suspension and termination

You may stop using the service and close your workspace at any time. We may suspend or terminate for material breach, non-payment, security risk, or unlawful use — with notice where practicable. On termination your right to use the service ends; sections that by nature survive (fees owed, liability, confidentiality, governing law) survive.

## 10. Confidentiality

Each party will protect the other's non-public information with reasonable care and use it only for these terms, except where disclosure is legally required.

## 11. Warranties and disclaimer

The service is provided **"as is" and "as available"**. To the maximum extent permitted by law we disclaim all implied warranties (including merchantability, fitness for a particular purpose and non-infringement) and do not warrant that the service will be uninterrupted, error-free, that anomaly, fraud or budget detection will catch every event, or that AI outputs are accurate. [COUNSEL: adapt for consumer-protection law where relevant.]

## 12. Limitation of liability

To the maximum extent permitted by law: (a) neither party is liable for indirect, incidental, special or consequential damages, or lost profits, revenue or data; and (b) each party's total liability under these terms is limited to [the fees you paid in the 12 months before the claim / AMOUNT]. Nothing limits liability that cannot lawfully be limited. [COUNSEL: negotiate caps, carve-outs (e.g. data-protection, confidentiality), and whether they are super-caps.]

## 13. Indemnity

You will defend and indemnify us against third-party claims arising from your Customer Data or your breach of section 3. [We will defend you against third-party claims that the service infringes IP rights — COUNSEL TO DECIDE.]

## 14. Changes

We may update these terms. We will give at least [30] days' notice of material changes; continued use after that is acceptance. If you object, you may terminate before they take effect.

## 15. General

Entire agreement; if a provision is unenforceable the rest remains; you may not assign without our consent; no waiver unless in writing. **Governing law:** [JURISDICTION]. **Disputes:** [COURTS / ARBITRATION SEAT]. Notices go to [EMAIL] and to the contact on your account.
