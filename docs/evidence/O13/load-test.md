# Load test: allocation and payouts

200 engagements, 20 at a time, on postgres. Path time 4.2 s (48.1 engagements a second); total with set-up 8.3 s.

Partner capacity is set to bind part-way: 137 engagement(s) ended waiting for a partner with room (the ops queue shows them as "No partner for some lines"), as they would in production.

| Step | Requests | p50 ms | p95 ms | max ms |
| --- | ---: | ---: | ---: | ---: |
| accept offer | 200 | 143 | 217 | 217 |
| deposit paid + allocation | 200 | 111 | 236 | 239 |
| allocation accepted | 63 | 224 | 237 | 239 |
| partner invoice | 63 | 22 | 33 | 118 |
| payout run exported | 1 | 5 | 5 | 5 |
| payout run paid | 1 | 29 | 29 | 29 |

| Invariant | Holds | Detail |
| --- | --- | --- |
| one payout per engagement, partner and stage | yes | 0 duplicates |
| no partner paid above the priced cost | yes | 0 over |
| each line accepted by one partner | yes | 0 lines twice |
| one payout run from two simultaneous presses | yes | 200, 409 |
| every payout in the run released once | yes | 63 released of 63 |
| no partner given more live work than its capacity | yes | within capacity |
| one engagement per accepted offer | yes | 200 of 200 |
| audit chain intact | yes | 2058 events in 6 ms |
