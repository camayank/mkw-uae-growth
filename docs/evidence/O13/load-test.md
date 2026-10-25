# Load test: allocation and payouts

200 engagements, 20 at a time, on postgres. Path time 4.0 s (50.6 engagements a second); total with set-up 8.3 s.

Partner capacity is set to bind part-way: 137 engagement(s) ended waiting for a partner with room (the ops queue shows them as "No partner for some lines"), as they would in production.

| Step | Requests | p50 ms | p95 ms | max ms |
| --- | ---: | ---: | ---: | ---: |
| accept offer | 200 | 133 | 179 | 179 |
| deposit paid + allocation | 200 | 112 | 245 | 248 |
| allocation accepted | 63 | 218 | 260 | 264 |
| partner invoice | 63 | 22 | 32 | 153 |
| payout run exported | 1 | 4 | 4 | 4 |
| payout run paid | 1 | 26 | 26 | 26 |

| Invariant | Holds | Detail |
| --- | --- | --- |
| one payout per engagement, partner and stage | yes | 0 duplicates |
| no partner paid above the priced cost | yes | 0 over |
| each line accepted by one partner | yes | 0 lines twice |
| one payout run from two simultaneous presses | yes | 409, 200 |
| every payout in the run released once | yes | 63 released of 63 |
| no partner given more live work than its capacity | yes | within capacity |
| one engagement per accepted offer | yes | 200 of 200 |
| audit chain intact | yes | 1595 events in 5 ms |
