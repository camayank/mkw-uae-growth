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
| Gold and dark panel (E9) | `--gold`, `--gold-ink`, `--gold-text`, `--ink-panel`, `--ink-panel-2`, `--ink-panel-text`, `--ink-panel-muted` | Gold is the one strongest action per screen and figures on a dark panel; the dark panel is the staff bar and the summary that matters most |
| Tints | `--brand-soft`, `--ok-soft`, `--warn-soft`, `--bad-soft`, `--info-soft` | Mixed from the state colours for backgrounds |
| Space | `--space-1` 4 px … `--space-7` 48 px | 4 px scale |
| Type | `--font-sans`, `--font-arabic`, `--text-xs` … `--text-2xl`, `--leading`, `--leading-tight` | 15 px body; sizes in rem |
| Shape | `--radius` (12 px), `--radius-sm`, `--radius-md` (10 px), `--radius-lg` (16 px), `--radius-pill` | Rounder from E9 |
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
| Offer switch | `section.card` with `nav.tiers`: the shown tier as `div.tier.best` marked selected, the others as `a.tier` with `.switch`; tier names from `TIER_LABEL` in `js/client.js`; no tier claims a pace (gap 85) | Client offer (U1) |
| Pinned next step | `section.nextaction` reused for the partner: the open step's evidence form inside it, `ul.todo` for what waits on others | Partner engagement (U1) |
| Tab bar | At 640 px and below, for `body[data-audience="client"|"partner"]`, `nav#nav` becomes a fixed bottom bar; each link carries an inline icon (`ICON` in `js/shell.js`), shown beside the label at every width from E9 | Client and partner phones (U1); MKW staff keep the grouped menu |
| Progress | `.progress[role=progressbar] > span` | Engagement cards |
| UAE colours (E9) | `div.flagbar` of four spans above `header.top` (red, green, white, black), decorative (`aria-hidden`) | The workspace and the selector (not the stand-alone intake page) |
| Strongest action (E9) | `.btn.gold` / `button.gold` added to the primary button: one per screen (the next action, accepting an offer); the timeline's own Approve stays plain so the pinned one is the only gold | Client home, offer, engagement |
| Journey (E9) | `journey(steps, label)` in `js/core.js`: `ol.journey > li.{done,now,upcoming}` with `.step`, the name and an optional `.what` (kept for screen readers on a phone); one step at most carries `aria-current="step"`; built from the platform's own states (`clientJourney` in `js/client.js`): advice only when there is some, "being priced" only while MKW prices, an expired offer said as such, a dispute named | Client home |
| Dark panel (E9) | `.panel-dark` on a card: white text, gold figures (`dd`, `.num`), gold links | Client money, the first KPI tile on staff screens (`.kpis.lead-kpis`) |
| KPI tile (E9) | `kpiTile(label, value, sub, icon)` in `js/core.js`: `.kpi` with `.ico`, the figure, the label | Staff dashboard and queue; partner Work, Performance (score first) and Payouts (E10) |
| Emirate flag (E9) | `flag(emirate)` in `js/core.js`: an inline simplified flag, nothing for an unknown name | Client engagements, staff request and lead pages, advice places; partner Work and engagement (E10) |
| Staff bar (E9) | `body[data-audience="platform"] .top` dark, entries with icons, the open entry underlined in gold; the M mark (MKW Advisors) for staff and partners, T for clients | Console; partners too from E10 (the dark top bar at every width; on a phone their tab bar stays light, and the menu's light-on-dark colours apply from 640 px up) |
| Report download | `a.btn[download]` to `/report.pdf` on the client advice page; `#report` button on the selector (saves first, then downloads) | Selector, client advice (E7D) |
| Funnel | `.kpis` from visitors to revenue, a stage table with the share of visitors, the by-source table, segment and lost-reason tables, and the attention list linking to each lead | Console Funnel (E7C) |
| Next best action | `form.next-action[data-form="lead-next-action"]` with the rule's action, its reason, the override and its reason; `nextActionCell` in the leads list ("today" badge when urgent) | Leads (E7C) |
| Coverage matrix | `.kpis`, a table of emirates by place kind, evidence per field, expiring evidence, approvals outstanding, the backlog by place with one `.badge` per field (title = what to obtain) and a `form[data-form="place-status"]` per place for the founder | Console Coverage (E7B) |
| Public homepage | `section.landing`: `.home-hero` (copy, `.ticks`, and `.hero-try` with the first question's tiles and the places on record), `.strip`, `.packages > .pkg` (approved "from" or "Price to be verified"), `.home-map` (the emirates map), `.industries > button.industry[data-activity]`, `.steps`, `.honest`, `.faq`, `.cta-band` | `selector.html` (E7A; E11 canvas look) |
| Question step | `progress.bar` + `.progress` text, `h2#qtitle`, `.choices > button.choice[aria-pressed]`, `p.why` ("Why we ask") | Selector (E7A) |
| Result as a decision | `dl.profile` with `a[data-edit]`, `p.legend`, `.pathways > .pathway(.rec)`, `.places > .place(.cmp-on)` with `input.cmp`, `#compare table` (row headers, up to five columns), `.guides > .guide` with `.badge.general`, `.card.next-action` | Selector (E7A) |

## Accessibility

WCAG 2.1 AA, checked by axe-core in the smoke test at 1280 px and 390 px in English and Arabic. Every control has a
name (`ensureLabels`), headings follow the page, focus moves to the main region on each route and to the next question
in the conversation, live regions announce the plan and file checks, anything `[hidden]` stays hidden whatever its
component's display, and tables that scroll sideways are reachable by keyboard. Numbers, amounts and references read
left to right in Arabic pages.
