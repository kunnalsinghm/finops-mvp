# RFC 0003 — Dashboard frontend framework migration

- **Status:** proposal. **Verdict: not ready. Do not migrate now.** The trigger that would change this is
  written down in §4.
- **Scope:** P2 item 8.
- **Reads first:** `docs/tech-stack-migration-plan.md` §2.

## 1. What the frontend is today (from the code)

- `public/index.html` plus `public/dashboard.js` (446 lines), no build step, no framework.
- Ten panels: Access, Cost Over Time, Cost by Team, Cost by Provider/Model, Budget Status, Recommendations,
  Recent Alerts, Shadow-Spend Reconciliation, Cache & Backups, Audit Log.
- Behaviour: themes, a login form, a token in `localStorage`, and render functions that build tables, cards
  and charts by assigning `innerHTML`.
- Other pages (`accept-invite.html`, reset/verify pages) are small standalone forms.

It is read-mostly: fetch, render, refresh. No screen holds complex state shared between components.

## 2. The project's own stated trigger

The migration plan (§2) says to adopt a framework when the first screen needs **shared reactive state**.
Nothing on today's list does. The nearest candidates, and why they do not qualify yet:

| Candidate | Why it does not meet the trigger |
|---|---|
| Invite management UI (not built) | A list plus a form; independent of other panels. |
| Onboarding wizard (P2 item 5) | Multi-step, but linear; local state in one component. A small module handles it. |
| Editing budgets/tagging rules inline | Not requested. |

## 3. Options

| Option | Cost | Notes |
|---|---|---|
| **A. Stay as is; extract helpers** | Low | Add an `escapeHtml` helper and use it consistently. Because every render writes `innerHTML`, any unescaped server string (team names, model names, audit fields) is an XSS risk. **This is the real finding, and it is independent of any framework** (not yet audited; see §5). |
| B. Small library for the new screens only (Preact/htm or Alpine, no build step) | Medium | Lets new screens be reactive without a toolchain; old panels untouched. A reasonable bridge if the wizard or invite UI grows. |
| C. Full migration to React/Vue + Vite + TypeScript | High: a build step in CI and the Dockerfile, a second test strategy (the repo has no frontend tests today), rewrite of 446 lines plus pages, bundle/CSP changes. | Pays off when there are many screens with shared state and a team working on them. Neither is true now. |

## 4. Recommendation and trigger

**Option A now.** Revisit with option B when any one of these becomes true:

1. A screen needs state shared across components (e.g. a filter that drives several panels and persists in
   the URL, or optimistic updates on a list).
2. `dashboard.js` passes roughly 1,000 lines, or a second person starts working on the frontend regularly.
3. The onboarding wizard (item 5) ends up with branching state.

Revisit option C only if B proves insufficient.

## 5. Cost of waiting, and what is unverified

- Cost of waiting: none that I can find. The frontend is not blocking any item in this list.
- **Not verified:** whether any current `innerHTML` render path is exploitable. I have read the structure,
  not audited each field's source. That audit is a small, separate task and worth doing regardless of the
  framework decision.
- **Not measured:** bundle size or load time; there is nothing to compare against until a migration is
  scoped.

## 6. Decisions needed

None to proceed with A. If you want the XSS audit, say so and I will do it as its own change with tests.

## 7. Rollback

Nothing to roll back: no code changes.
