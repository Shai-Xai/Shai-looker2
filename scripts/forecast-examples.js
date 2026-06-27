// Worked forecast examples on REAL last-year data (KFF 26, from the goal-detail
// screenshot's per-checkpoint "last time" values) — validates server/forecast.js
// before we wire it to live Looker + the UI. Run: node scripts/forecast-examples.js
const { forecast, fractionAt } = require('../server/forecast');

// Last year's CUMULATIVE ticket sales by the 10th of each month, ending at the
// event-day total. Straight from the screenshot's "last time …" column.
const lastYear = [
  ['10 Aug 25', 6843], ['10 Sep 25', 6844], ['10 Oct 25', 7450], ['10 Nov 25', 8006],
  ['10 Dec 25', 8895], ['10 Jan 26', 10018], ['10 Feb 26', 16836], ['10 Mar 26', 25433],
  ['10 Apr 26', 30293], ['10 May 26', 33606], ['10 Jun 26', 38321], ['~02 Jul 26 (event)', 43310],
];
const cum = lastYear.map(([, v]) => v);
const lastTotal = cum[cum.length - 1];

// Where this year's KFF 26 stands now (screenshot): ~20 Jun, deadline 02 Jul.
const currentValue = 41029;
const target = 60000;
const daysLeft = 12; // 20 Jun → 02 Jul
// Position in the cycle: between 10 Jun (index 10) and event day (index 11),
// 10 of the 22 days elapsed → r in the curve's index space.
const r = (10 + 10 / 22) / (cum.length - 1);

const f = (n) => Number(n).toLocaleString('en-ZA');
const pct = (x) => `${Math.round(x * 100)}%`;

console.log('\n=== KFF 26 — last year curve (real) ===');
console.log(`points: ${cum.length}   last-year total: ${f(lastTotal)}`);
console.log(`now ≈ 20 Jun → r=${r.toFixed(3)} of the cycle; last year had reached ${pct(fractionAt(cum, r))} by this point`);
console.log(`this year now: ${f(currentValue)}   target: ${f(target)}   days left: ${daysLeft}\n`);

// Three momentum scenarios for the last-30-day rate (this year). Last year's own
// near-event rate ran ~150/day (mid-cycle) rising to ~225/day in the final stretch.
const scenarios = [
  ['cold  (~150/day)', 150],
  ['match (~230/day)', 230],
  ['hot   (~450/day)', 450],
];

console.log('scenario              shape-only   momentum   blended(proj)   range            vs target   verdict');
console.log('-'.repeat(98));
for (const [label, rate] of scenarios) {
  const r0 = forecast({ cum, currentValue, target, r, daysLeft, recentRatePerDay: rate });
  const row = [
    label.padEnd(20),
    f(r0.shape).padStart(10),
    f(r0.momentum).padStart(10),
    f(r0.projected).padStart(13),
    `${f(r0.range[0])}–${f(r0.range[1])}`.padStart(15),
    `${r0.vsTargetPct}%`.padStart(10),
    `   ${r0.status}`,
  ];
  console.log(row.join('  '));
}

// Contrast: same trajectory, but a realistic target (+5% on last year) → should hit.
console.log('\n=== same pace, realistic target (45 000 = +4% on last year) ===');
const real = forecast({ cum, currentValue, target: 45000, r, daysLeft, recentRatePerDay: 230 });
console.log(`projected ${f(real.projected)}  range ${f(real.range[0])}–${f(real.range[1])}  vs target ${real.vsTargetPct}%  → ${real.status}`);

console.log('\n=== plain-English read (what the card would say) ===');
const head = forecast({ cum, currentValue, target, r, daysLeft, recentRatePerDay: 230 });
console.log(`Forecast ~${f(head.projected)} by 02 Jul (range ${f(head.range[0])}–${f(head.range[1])}).`);
console.log(`That's ${head.vsTargetPct}% of your ${f(target)} target — about level with last year (${f(lastTotal)}),`);
console.log(`so on this trajectory you'd finish ~${f(target - head.projected)} short.\n`);
