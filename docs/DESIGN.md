# Tasees design system

The screens are plain HTML from ES modules (`apps/web/public/js/`), styled by two files: `tokens.css` (every value)
and `styles.css` (layout and components, built from the tokens). No build step, no framework, no web fonts: the
system font in the reader's own language. This page lists the tokens and the patterns; when a screen needs something
new, add a token or a pattern here first.

## Principles (from docs/VISION.md)

1. **One next action.** Every client screen opens with the single thing Tasees needs from them, or says plainly that
   nothing is needed and what happens next.
2. **Status at a glance.** A timeline for an engagement, a ranked queue for ops, a proposal for an offer.
3. **Money in plain sight, by role.** Fees, government fees and VAT always separate; what a role must not see is
   absent, never greyed out. An UNCERTAIN figure carries one sentence saying why and what happens next.
4. **Conversation over forms.** Intake asks one question at a time; uploads are checked before they leave the page.
5. **Say the rule before it bites.** Expiry, automatic approval, the guarantee and "we do not file for you" are stated
   where the client acts.

## Tokens (`tokens.css`)

| Group | Tokens | Notes |
| --- | --- | --- |
| Colour | `--bg`, `--surface`, `--surface-2`, `--text`, `--muted`, `--line`, `--brand`, `--brand-ink`, `--accent`, `--ok`, `--warn`, `--bad`, `--info` | Light and dark sets; text tokens keep 4.5:1 on `--bg` and `--surface` |
| Tints | `--brand-soft`, `--ok-soft`, `--warn-soft`, `--bad-soft`, `--info-soft` | Mixed from the state colours for backgrounds |
| Space | `--space-1` 4 px … `--space-7` 48 px | 4 px scale |
| Type | `--font-sans`, `--font-arabic`, `--text-xs` … `--text-2xl`, `--leading`, `--leading-tight` | 15 px body; sizes in rem |
| Shape | `--radius` (10 px), `--radius-sm`, `--radius-md`, `--radius-lg`, `--radius-pill` | |
| Depth | `--shadow`, `--shadow-lg` | None in dark mode |
| Motion | `--motion-fast`, `--motion`, `--ease` | Switched off by `prefers-reduced-motion` |
| Focus | `--focus-ring` | One visible ring everywhere (`:focus-visible`) |

## Patterns

| Pattern | Markup | Used for |
| --- | --- | --- |
| Next action | `section.nextaction` (`.calm` when nothing is needed), `.eyebrow`, `h2`, why, one primary button; `details.more` for the rest | Client home and engagement (`nextActionCard` in `js/client.js`) |
| Timeline | `ol.timeline > li.tl.{done,now,mkw,partner,upcoming,issue}` with `.tl-dot` and `.tl-body` | The client's engagement |
| Proposal | `.proposal` of `section.card`s: what we will do, how it will run (`ol.steps`), what it costs (`.paysplit`), guarantee, before you accept (`ul.rules`) | Client offer |
| Conversation | `form.convo` with one visible `fieldset.q` (its `legend` takes focus), Back / Next, and `aside.plan` (live region) | Client intake |
| Checked upload | `dropzone(expect, label)` in `js/core.js`: `label.dropzone` around the file input, `p.field-msg` (live), `form.upload-row` in lists; `checkFile` runs on choose, drop and submit | Client documents, filing evidence; the same check on every upload |
| Ranked queue | `ol.qlist > li.qitem.{overdue,due_soon,on_track}` with why line, factors, inline `.qdraft`, buttons tied to the title by `aria-describedby` | Ops command centre (O11) |
| System health | `section.card` per concern (alerts as `ol.qlist`, runs with steps in `details`, messages waiting, audit checks) | Setup → System (O13) |
| Status chip | `.badge.{ok,warn,bad,info}` via `badge(status, label)` | Everywhere |
| In short | `section.summary` with `.eyebrow`, one plain `h2`, the first reason with its label, `.confirm` cards for the points to confirm | The client's advice (`inShort` in `js/ops.js`), above `details.reasoning` holding the full advice (U1) |
| Folding panel | `details.panel > summary > h2 + .state` then `.panel-body`, via `panel(title, body, {state, open, id})` in `js/core.js`; the heading carries the state so a closed panel still says what is in it; a jump opens it first | Client and partner engagement pages; open only while something needs the reader (U1) |
| Offer switch | `section.card` with `nav.tiers`: the shown tier as `div.tier.best` marked selected, the others as `a.tier` with `.switch`; the priority tier reads "Faster" (`TIER_LABEL` in `js/client.js`) | Client offer (U1) |
| Pinned next step | `section.nextaction` reused for the partner: the open step's evidence form inside it, `ul.todo` for what waits on others | Partner engagement (U1) |
| Tab bar | At 640 px and below, for `body[data-audience="client"|"partner"]`, `nav#nav` becomes a fixed bottom bar; each link carries an inline icon (`ICON` in `js/shell.js`) shown only there | Client and partner phones (U1); MKW staff keep the grouped menu |
| Progress | `.progress[role=progressbar] > span` | Engagement cards |

## Accessibility

WCAG 2.1 AA, checked by axe-core in the smoke test at 1280 px and 390 px in English and Arabic. Every control has a
name (`ensureLabels`), headings follow the page, focus moves to the main region on each route and to the next question
in the conversation, live regions announce the plan and file checks, anything `[hidden]` stays hidden whatever its
component's display, and tables that scroll sideways are reachable by keyboard. Numbers, amounts and references read
left to right in Arabic pages.
