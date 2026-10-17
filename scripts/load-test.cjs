#!/usr/bin/env node
// P13 load test: sends to N and 2N simulated recipients across text, email and voice with realistic latency and failure rates,
// using the real worker, and reports p50/p95/p99 time to reach people and to complete.
//   node scripts/load-test.cjs --headcount 5000 --out docs/load-test-report.md
// Options: --headcount N (default 1000)  --speed K (time compression, default 10; use 1 for real time)  --workers W (default 1)
//          --concurrency C (default 20)   --sms-rate/--email-rate/--voice-rate per second (carrier limit; default unlimited)
//          --voice-max-active M (default 0 = no cap)  --seed S  --out file.md
const fs = require('fs');
const { runScenario } = require('./loadTestCore.cjs');

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : d; };
const headcount = Number(opt('headcount', 1000));
const speed = Number(opt('speed', 10));
const base = {
  speed, workers: Number(opt('workers', 1)), concurrency: Number(opt('concurrency', 20)), seed: Number(opt('seed', 42)),
  rate: { sms: Number(opt('sms-rate', 0)), email: Number(opt('email-rate', 0)), voice: Number(opt('voice-rate', 0)) },
  voiceMaxActive: Number(opt('voice-max-active', 0)),
};
const sendsPerSec = (r) => r.sendsPerSec;
const fmt = (s) => (s === null || s === undefined ? '-' : s >= 120 ? `${(s / 60).toFixed(1)} min` : `${s.toFixed(1)} s`);

(async () => {
  const scenarios = [];
  for (const mult of [1, 2]) for (const mode of ['together', 'fallback']) scenarios.push({ mult, mode, people: headcount * mult });
  const results = [];
  for (const s of scenarios) {
    process.stderr.write(`running ${s.people} people, ${s.mode}...\n`);
    results.push({ ...s, r: await runScenario({ ...base, people: s.people, mode: s.mode }) });
  }
  const lines = [];
  lines.push('# eMNS load test report', '', `Generated ${new Date().toISOString()}. Headcount tested: ${headcount} and ${headcount * 2} (2x).`, '');
  lines.push('## Method', '',
    '- The real worker (`src/server/broadcast/worker.cjs`) runs against an in-memory model of the queue that follows the same rules as the database functions (claim, retry, fallback release, call cap). Providers are simulated; nothing is sent.',
    `- Simulated provider latency (median, lognormal, p99 about 3x): text ${DEF('sms')} ms, email ${DEF('email')} ms, voice ${DEF('voice')} ms. Permanent failures (bad number or address, triggers fallback): text 3%, email 2%, voice 8%. Temporary failures (retried after 30 s, 60 s): about 2 to 3%.`,
    `- Retries wait for the once-a-minute sweeper, as in production. Workers: ${base.workers}, parallel sends per worker: ${base.concurrency}. Carrier rate limits: ${base.rate.sms || base.rate.email || base.rate.voice ? JSON.stringify(base.rate) + ' per second' : 'none (unlimited)'}.`,
    `- Time compression x${speed}: delays are shortened and measured times scaled back up, so our own overhead is overstated by that factor (conservative). Real run time was ${results.map((x) => x.r.realSeconds.toFixed(1)).join(' s, ')} s.`, '');
  lines.push('## Results', '', '"Reached" = time until a person has at least one message accepted by the provider. "Complete" = time until every channel for that person has finished (sent, failed, or never needed).', '');
  lines.push('| People | Mode | Reached p50 | p95 | p99 | Complete p50 | p95 | p99 | Whole run | Sends per second (main phase) | People with no message accepted | Exactly once | Stuck |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const { people, mode, r } of results) {
    lines.push(`| ${people} | ${mode === 'together' ? 'all channels at once' : 'in order (fallback)'} | ${fmt(r.reached.p50)} | ${fmt(r.reached.p95)} | ${fmt(r.reached.p99)} | ${fmt(r.done.p50)} | ${fmt(r.done.p95)} | ${fmt(r.done.p99)} | ${fmt(r.totalSeconds)} | ${sendsPerSec(r).toFixed(0)} | ${r.unreached} | ${r.exactlyOnce ? 'yes' : 'NO'} | ${r.stuck} |`);
  }
  lines.push('', '## By channel (largest run)', '', '| Channel | Rows | Sent | Failed | Held (not needed) | Finished after |', '|---|---|---|---|---|---|');
  const last = results[results.length - 1];
  const tog = results[results.length - 2];
  for (const [c, v] of Object.entries(tog.r.perChannel)) lines.push(`| ${c} (all at once, ${tog.people}) | ${v.rows} | ${v.sent} | ${v.failed} | ${v.held} | ${fmt(v.finishedAfterSec)} |`);
  lines.push('', '## Reading the results', '',
    `- Capacity of one worker with ${base.concurrency} parallel sends is about ${Math.round(sendsPerSec(tog.r))} sends per second in these runs. When all channels go at once, people near the end of the queue wait for the ones ahead of them, so p50 and p95 grow with headcount (doubling the headcount about doubles them). Add workers (\`--workers\`) or raise parallel sends (\`--concurrency\`) to cut that time.`,
    '- In fallback mode only the first channel is sent unless it fails, so far fewer sends are needed and people are reached much sooner.',
    '- The slowest few percent are people whose first attempt hit a temporary failure: the retry waits 30 s and then for the next once-a-minute sweep, so p99 and the whole run include at least that wait.',
    '- This proves the system side only. The 10-minute target also depends on what the carrier accepts per second for your registered campaign and on how fast people answer. Re-run with `--sms-rate`, `--email-rate`, `--voice-rate` and `--voice-max-active` set to the real limits once A2P approval and the voice account limits are known.',
    '- Re-run at the customer headcount when it is known: `node scripts/load-test.cjs --headcount <N> --out docs/load-test-report.md`.',
    `- Every delivery reached exactly one final state in all runs: ${results.every((x) => x.r.exactlyOnce && x.r.stuck === 0) ? 'yes' : 'NO, investigate'}.`);
  const text = lines.join('\n') + '\n';
  const out = opt('out', null);
  if (out) { fs.writeFileSync(out, text); process.stderr.write(`report written to ${out}\n`); }
  process.stdout.write(text);
  function DEF(c) { return require('./loadTestCore.cjs').DEFAULTS.latencyMs[c]; }
})();
