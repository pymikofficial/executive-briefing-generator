#!/usr/bin/env node
// Smoke test for Executive Briefing Generator, run against the LIVE deployed
// site (not local dev), since it hits real Netlify Functions + Blobs + the
// real Anthropic API. Verifies exactly the 4 things a manual browser check
// would, but automatically and with hard pass/fail output.
//
// Usage: node scripts/smoke-test.mjs [base_url]
// Default base_url: https://executive-briefing-generator.netlify.app

const BASE_URL = process.argv[2] || 'https://executive-briefing-generator.netlify.app';
const POLL_MS = 2000;
const MAX_POLLS = 45; // ~90s ceiling, matches the frontend's own timeout

const TEST_INPUT = `
- standup: Priya blocked on API keys, needs them by EOD, email her at priya.test@example.com if urgent
- investor email from Rahul (call him at +91 98765 43210), wants updated MRR numbers before Thursday
- hosting renewal quote expires Friday, 12% increase, need a decision
- broken signup link on pricing page, someone should just fix it
- interview candidate no-showed yesterday, reschedule whenever
- idea: monthly customer newsletter, no rush
`.trim();

function log(msg) { console.log(msg); }
function fail(msg) { console.log('FAIL: ' + msg); process.exitCode = 1; }
function pass(msg) { console.log('PASS: ' + msg); }

async function main() {
  const jobId = 'smoketest-' + Date.now();
  log(`Testing ${BASE_URL}`);
  log(`Job ID: ${jobId}\n`);

  const startedAt = Date.now();

  let kickoff;
  try {
    kickoff = await fetch(`${BASE_URL}/.netlify/functions/generate-brief-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, text: TEST_INPUT })
    });
  } catch (e) {
    fail(`Could not reach generate-brief-background: ${e.message}`);
    return;
  }
  if (kickoff.status !== 202 && kickoff.status !== 200) {
    fail(`Unexpected status from background function: ${kickoff.status}`);
    return;
  }

  let record = null;
  for (let i = 0; i < MAX_POLLS; i++) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    let res;
    try {
      res = await fetch(`${BASE_URL}/.netlify/functions/check-brief?jobId=${encodeURIComponent(jobId)}`);
    } catch (e) {
      continue;
    }
    const data = await res.json();
    if (data.status === 'done' || data.status === 'error') {
      record = data;
      break;
    }
  }

  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);

  if (!record) {
    fail(`Timed out after ~90s with no done/error status.`);
    return;
  }
  if (record.status === 'error') {
    fail(`Server returned an error: ${record.message}`);
    return;
  }
  if (Number(elapsedSec) <= 90) {
    pass(`Generated in ${elapsedSec}s (within 90s budget).`);
  } else {
    fail(`Took ${elapsedSec}s, over the 90s budget.`);
  }

  const b = record.brief || {};

  const structureIssues = [];
  if (!b.headline) structureIssues.push('missing headline');
  if (!Array.isArray(b.priorities) || b.priorities.length > 3) structureIssues.push('priorities missing or >3 items');
  if (!Array.isArray(b.decisions)) structureIssues.push('decisions not an array');
  if (!Array.isArray(b.delegate)) structureIssues.push('delegate not an array');
  if (!Array.isArray(b.can_wait)) structureIssues.push('can_wait not an array');

  if (structureIssues.length === 0) {
    pass(`Brief structure looks right (headline, ${b.priorities.length} priorities, ${b.decisions.length} decisions, ${b.delegate.length} delegate, ${b.can_wait.length} can-wait).`);
  } else {
    fail(`Brief structure issues: ${structureIssues.join(', ')}`);
  }

  if (Array.isArray(b.audit_flags)) {
    pass(`Auditor ran (${b.audit_flags.length} flag${b.audit_flags.length === 1 ? '' : 's'}${b.audit_flags.length ? ': ' + b.audit_flags.join(' | ') : ', clean pass'}).`);
  } else {
    fail(`No audit_flags field returned, auditor pass may not have run.`);
  }

  const scrub = record.scrubCounts || {};
  if ((scrub.emails || 0) >= 1 && (scrub.phones || 0) >= 1) {
    pass(`PII scrub confirmed: ${scrub.emails} email(s), ${scrub.phones} phone(s) removed before the API call.`);
  } else {
    fail(`Expected 1+ email and 1+ phone scrubbed, got emails=${scrub.emails || 0} phones=${scrub.phones || 0}.`);
  }

  log('\n--- Full brief (for manual eyeballing) ---');
  log(JSON.stringify(b, null, 2));
}

main();
