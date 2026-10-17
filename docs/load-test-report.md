# eMNS load test report

Generated 2026-10-17T06:02:06.526Z. Headcount tested: 1000 and 2000 (2x).

## Method

- The real worker (`src/server/broadcast/worker.cjs`) runs against an in-memory model of the queue that follows the same rules as the database functions (claim, retry, fallback release, call cap). Providers are simulated; nothing is sent.
- Simulated provider latency (median, lognormal, p99 about 3x): text 150 ms, email 300 ms, voice 500 ms. Permanent failures (bad number or address, triggers fallback): text 3%, email 2%, voice 8%. Temporary failures (retried after 30 s, 60 s): about 2 to 3%.
- Retries wait for the once-a-minute sweeper, as in production. Workers: 1, parallel sends per worker: 20. Carrier rate limits: none (unlimited).
- Time compression x20: delays are shortened and measured times scaled back up, so our own overhead is overstated by that factor (conservative). Real run time was 6.1 s, 3.0 s, 12.0 s, 9.0 s.

## Results

"Reached" = time until a person has at least one message accepted by the provider. "Complete" = time until every channel for that person has finished (sent, failed, or never needed).

| People | Mode | Reached p50 | p95 | p99 | Complete p50 | p95 | p99 | Whole run | Sends per second (main phase) | People with no message accepted | Exactly once | Stuck |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1000 | all channels at once | 37.9 s | 74.3 s | 78.0 s | 41.1 s | 78.1 s | 2.0 min | 2.0 min | 37 | 1 | yes | 0 |
| 1000 | in order (fallback) | 5.9 s | 10.8 s | 60.2 s | 5.9 s | 10.8 s | 60.2 s | 60.5 s | 88 | 0 | yes | 0 |
| 2000 | all channels at once | 75.5 s | 2.4 min | 2.5 min | 78.2 s | 2.5 min | 3.0 min | 4.0 min | 39 | 0 | yes | 0 |
| 2000 | in order (fallback) | 11.4 s | 21.4 s | 60.4 s | 11.4 s | 21.4 s | 60.4 s | 3.0 min | 91 | 0 | yes | 0 |

## By channel (largest run)

| Channel | Rows | Sent | Failed | Held (not needed) | Finished after |
|---|---|---|---|---|---|
| sms (all at once, 2000) | 2000 | 1957 | 43 | 0 | 3.0 min |
| email (all at once, 2000) | 2000 | 1966 | 34 | 0 | 3.0 min |
| voice (all at once, 2000) | 2000 | 1842 | 158 | 0 | 4.0 min |

## Reading the results

- Capacity of one worker with 20 parallel sends is about 39 sends per second in these runs. When all channels go at once, people near the end of the queue wait for the ones ahead of them, so p50 and p95 grow with headcount (doubling the headcount about doubles them). Add workers (`--workers`) or raise parallel sends (`--concurrency`) to cut that time.
- In fallback mode only the first channel is sent unless it fails, so far fewer sends are needed and people are reached much sooner.
- The slowest few percent are people whose first attempt hit a temporary failure: the retry waits 30 s and then for the next once-a-minute sweep, so p99 and the whole run include at least that wait.
- This proves the system side only. The 10-minute target also depends on what the carrier accepts per second for your registered campaign and on how fast people answer. Re-run with `--sms-rate`, `--email-rate`, `--voice-rate` and `--voice-max-active` set to the real limits once A2P approval and the voice account limits are known.
- Re-run at the customer headcount when it is known: `node scripts/load-test.cjs --headcount <N> --out docs/load-test-report.md`.
- Every delivery reached exactly one final state in all runs: yes.
