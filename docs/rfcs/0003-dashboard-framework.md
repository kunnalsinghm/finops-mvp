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
- **XSS audit: done** (see CHANGELOG, "Dashboard output is escaped"). Result: yes, exploitable markup
  injection. `dashboard.js` had 25 `innerHTML` writes interpolating strings an API-key holder controls (model
  name, team, agent id, key label, alert text, audit actor/target); a model name of `<img src=x onerror=...>`
  became a live element in an administrator's dashboard. The CSP (`script-src 'self'`, `script-src-attr
  'none'`) would have stopped a browser running the handler, so this was markup injection, not script
  execution, in a CSP-enforcing browser. Fixed by `public/render.js` (an escaping `html` template plus a single
  `setHtml` sink), enforced by `test/dashboardRender.test.js`. This is option A from section 3, done, and it
  makes the framework migration less urgent, not more.
- **Not measured:** bundle size or load time; there is nothing to compare against until a migration is
  scoped.

## 6. Decisions needed

None. Option A (escaping helper) is implemented; the framework decision is still not forced by any problem found.

## 7. Rollback

Nothing to roll back: no code changes.
