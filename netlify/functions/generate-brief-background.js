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

const DAILY_CAP = 25; // guardrail: public tool, keep API spend bounded
const MAX_INPUT_CHARS = 24000; // ~6k tokens of raw notes, plenty for one day's mess

exports.handler = async (event) => {
  const store = getStore({ name: 'briefs', ...BLOBS_CONFIG });
  let jobId = null;

  try {
    const body = JSON.parse(event.body || '{}');
    jobId = body.jobId;
    const rawText = (body.text || '').slice(0, MAX_INPUT_CHARS);

    if (!jobId || !rawText.trim()) {
      return; // nothing sensible to do; client will time out and show an error
    }

    await store.setJSON(jobId, { status: 'pending' });

    // --- Guardrail 1: daily rate limit via a Blob counter ---
    const today = new Date().toISOString().slice(0, 10);
    const limitStore = getStore({ name: 'rate-limits', ...BLOBS_CONFIG });
    const counterKey = `briefs-${today}`;
    let count = 0;
    try {
      const existing = await limitStore.get(counterKey);
      count = existing ? parseInt(existing, 10) : 0;
    } catch (e) {
      count = 0;
    }
    if (count >= DAILY_CAP) {
      await store.setJSON(jobId, {
        status: 'error',
        message: "Today's free generation limit has been reached. Come back tomorrow."
      });
      return;
    }
    await limitStore.set(counterKey, String(count + 1));

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
