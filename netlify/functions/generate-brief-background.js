// Executive Briefing Generator ~ background function.
// Netlify auto-responds 202 for "-background" suffixed functions, so the slow
// work (two Claude calls) happens after the client has already been released.
// The client polls check-brief.js with the same jobId.
//
// Pipeline: rate-limit check -> PII scrub -> Claude call 1 (draft brief)
//           -> Claude call 2 (auditor verifies nothing significant was dropped)
//           -> final JSON written to Blobs.

const { getStore } = require('@netlify/blobs');

// Lesson learned (documented in NOTES.md across cosmik.work projects):
// getStore MUST receive explicit siteID and token in this account's setup,
// or it throws "The environment has not been configured to use Netlify Blobs".
const BLOBS_CONFIG = {
  siteID: process.env.NETLIFY_SITE_ID,
  token: process.env.NETLIFY_BLOBS_TOKEN
};

const DAILY_CAP = parseInt(process.env.DAILY_CAP || '25', 10); // guardrail: public tool, keep API spend bounded
const DAILY_CAP_PER_IP = parseInt(process.env.DAILY_CAP_PER_IP || '8', 10); // this tool makes 2 Claude calls per job, so cap tighter per-IP than a single-call tool
const MAX_INPUT_CHARS = 24000; // ~6k tokens of raw notes, plenty for one day's mess

function clientIp(event) {
  return ((event.headers && (event.headers['x-nf-client-connection-ip'] || event.headers['x-forwarded-for'])) || 'unknown').split(',')[0].trim();
}

exports.handler = async (event) => {
  const store = getStore({ name: 'briefs', ...BLOBS_CONFIG });
  let jobId = null;

  try {
    const body = JSON.parse(event.body || '{}');
    const jobIdRaw = (body.jobId || '').toString().slice(0, 64);
    jobId = /^[a-zA-Z0-9-]{1,64}$/.test(jobIdRaw) ? jobIdRaw : null;
    const rawText = (body.text || '').slice(0, MAX_INPUT_CHARS);

    if (!jobId || !rawText.trim()) {
      return; // nothing sensible to do; client will time out and show an error
    }

    await store.setJSON(jobId, { status: 'pending' });

    // --- Guardrail 1: daily rate limit (global + per-IP) via Blob counters ---
    const limitStore = getStore({ name: 'rate-limits', ...BLOBS_CONFIG });
    const usage = await checkAndBumpUsage(limitStore, event);
    if (!usage.ok) {
      const message = usage.reason === 'ip'
        ? "You've hit today's per-user generation limit. Check back shortly."
        : "Today's free generation limit has been reached. Come back tomorrow.";
      await store.setJSON(jobId, { status: 'error', message });
      return;
    }

    // --- Guardrail 2: PII scrub before anything reaches the API ---
    const { scrubbed, scrubCounts } = scrubPII(rawText);

    // --- Call 1: draft the brief ---
    const draft = await callClaude([
      {
        role: 'user',
        content: DRAFT_PROMPT + '\n\n<raw_notes>\n' + scrubbed + '\n</raw_notes>'
      }
    ]);
    const draftJSON = parseModelJSON(draft);

    // --- Call 2: auditor pass ~ checks the draft against the raw input ---
    const audited = await callClaude([
      {
        role: 'user',
        content:
          AUDIT_PROMPT +
          '\n\n<raw_notes>\n' + scrubbed + '\n</raw_notes>\n\n<draft_brief>\n' +
          JSON.stringify(draftJSON) +
          '\n</draft_brief>'
      }
    ]);
    const finalJSON = parseModelJSON(audited);

    await store.setJSON(jobId, {
      status: 'done',
      brief: finalJSON,
      scrubCounts
    });
  } catch (err) {
    console.error('generate-brief error:', err);
    if (jobId) {
      try {
        await store.setJSON(jobId, {
          status: 'error',
          message: 'Generation failed. Try again in a minute.'
        });
      } catch (e) {}
    }
  }
};

// ---------------------------------------------------------------------------

// Netlify Blobs has no conditional/compare-and-swap write, so a true atomic
// increment isn't possible here. This narrows (does not eliminate) the race
// window between the check and the write: re-reading right before writing,
// after a small random delay, makes it less likely that two concurrent
// requests both act on the same stale count.
async function checkAndBumpUsage(limitStore, event) {
  const today = new Date().toISOString().slice(0, 10);
  const globalKey = `briefs-${today}`;
  const ipKey = `briefs-${today}-ip-${clientIp(event)}`;

  const read = async (key) => {
    try {
      const existing = await limitStore.get(key);
      return existing ? parseInt(existing, 10) : 0;
    } catch (e) {
      return 0;
    }
  };

  if ((await read(globalKey)) >= DAILY_CAP) return { ok: false, reason: 'global' };
  if ((await read(ipKey)) >= DAILY_CAP_PER_IP) return { ok: false, reason: 'ip' };

  await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 120)));

  const [globalCount, ipCount] = [await read(globalKey), await read(ipKey)];
  if (globalCount >= DAILY_CAP) return { ok: false, reason: 'global' };
  if (ipCount >= DAILY_CAP_PER_IP) return { ok: false, reason: 'ip' };

  await Promise.all([
    limitStore.set(globalKey, String(globalCount + 1)),
    limitStore.set(ipKey, String(ipCount + 1))
  ]);
  return { ok: true };
}

function scrubPII(text) {
  const scrubCounts = { emails: 0, phones: 0 };

  let out = text.replace(
    /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
    () => { scrubCounts.emails++; return '[email removed]'; }
  );

  // Phone numbers: international/local formats, 8+ digits with separators.
  // Lookbehind/lookahead keep digit runs glued to letters or hyphens intact,
  // so invoice numbers, PO numbers, and IDs like INV-2026-000123 survive.
  out = out.replace(
    /(?<![A-Za-z0-9-])(\+?\d[\d\s()./-]{6,}\d)(?![A-Za-z0-9])/g,
    (match) => {
      const digits = match.replace(/\D/g, '');
      // Real phone numbers are 8-15 digits and don't look like dates (which
      // are exactly 8 digits in DD-MM-YYYY / YYYY-MM-DD shapes with 2 seps).
      const seps = (match.match(/[/-]/g) || []).length;
      const looksLikeDate = digits.length === 8 && seps === 2;
      if (digits.length >= 8 && digits.length <= 15 && !looksLikeDate) {
        scrubCounts.phones++;
        return '[phone removed]';
      }
      return match;
    }
  );

  return { scrubbed: out, scrubCounts };
}

async function callClaude(messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error('Anthropic API ' + res.status + ': ' + errText.slice(0, 300));
  }

  const data = await res.json();
  return data.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

function parseModelJSON(text) {
  const clean = text.replace(/```json|```/g, '').trim();
  const start = clean.indexOf('{');
  const end = clean.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('Model did not return JSON.');
  }
  return JSON.parse(clean.slice(start, end + 1));
}

// ---------------------------------------------------------------------------

const DRAFT_PROMPT = `You are an experienced Chief of Staff preparing a daily executive brief for a busy founder. You will receive a messy dump of raw notes: meeting fragments, email snippets, half-formed to-dos, Slack messages, all mixed together.

Turn it into a clean brief. Respond with ONLY a JSON object, no preamble, no markdown fences, in exactly this shape:

{
  "headline": "One sentence capturing the single most important thing today.",
  "priorities": [{"item": "...", "why": "one short line on why this is top-3"}],
  "decisions": [{"item": "...", "context": "what the founder needs to know to decide"}],
  "delegate": [{"item": "...", "to_whom": "role or person type if inferable, else 'anyone capable'"}],
  "can_wait": ["...", "..."]
}

Rules:
- "priorities" holds at most 3 items. Ruthless triage is the entire point.
- "decisions" holds only items genuinely blocked on the founder personally.
- "delegate" holds items someone else could own today.
- "can_wait" holds everything real but non-urgent, as short strings.
- Never invent items that are not grounded in the notes.
- Keep every line tight. A founder reads this in 60 seconds.`;

const AUDIT_PROMPT = `You are an auditor reviewing another assistant's executive brief against the raw notes it was built from. Your job:

1. Check whether anything SIGNIFICANT in the raw notes is missing from the brief (a real commitment, deadline, decision, or risk ~ not trivia).
2. Check that no item in the brief was invented or distorted.
3. Produce the corrected final brief.

Respond with ONLY a JSON object, no preamble, no markdown fences, in exactly the same shape as the draft, plus one extra field:

"audit_flags": ["short note per correction made, e.g. 'Added missed Friday payroll deadline to priorities'", ...]

If the draft was already complete and accurate, return it unchanged with "audit_flags": [].`;
