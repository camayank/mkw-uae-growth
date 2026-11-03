# Load test: allocation and payouts

40 engagements, 10 at a time, on postgres. Path time 0.9 s (44.3 engagements a second); total with set-up 2.0 s.

Partner capacity is set to bind part-way: 25 engagement(s) ended waiting for a partner with room (the ops queue shows them as "No partner for some lines"), as they would in production.

| Step | Requests | p50 ms | p95 ms | max ms |
| --- | ---: | ---: | ---: | ---: |
| accept offer | 40 | 77 | 141 | 141 |
| deposit paid + allocation | 40 | 47 | 123 | 139 |
| allocation accepted | 15 | 96 | 119 | 119 |
| partner invoice | 15 | 46 | 57 | 57 |
| payout run exported | 1 | 7 | 7 | 7 |
| payout run paid | 1 | 31 | 31 | 31 |

| Invariant | Holds | Detail |
| --- | --- | --- |
| one payout per engagement, partner and stage | yes | 0 duplicates |
| no partner paid above the priced cost | yes | 0 over |
| each line accepted by one partner | yes | 0 lines twice |
| one payout run from two simultaneous presses | yes | 409, 200 |
| every payout in the run released once | yes | 15 released of 15 |
| no partner given more live work than its capacity | yes | within capacity |
| one engagement per accepted offer | yes | 40 of 40 |
| audit chain intact | yes | 426 events in 2 ms |
