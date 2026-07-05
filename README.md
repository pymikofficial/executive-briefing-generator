# Executive Briefing Generator

Paste a messy day's raw material: meeting fragments, email snippets, Slack pings, half-formed to-dos. Get back what a Chief of Staff would hand a founder: top 3 priorities, decisions only the founder can make, what to delegate, and what can genuinely wait.

**Live:** [cosmik-briefing.netlify.app](https://cosmik-briefing.netlify.app)

## The headache

As EA/Chief of Staff to a founder, I did this exact triage manually every day: reading through a scattered stream of messages, notes, and requests, and compressing it into "here's what actually matters today, here's what's waiting on you, here's what I've handed off." The judgment stays human. The compression is automatable.

## The machinery

Single-page frontend, two Netlify Functions, Netlify Blobs for job state.

1. Frontend generates a `jobId` and POSTs the raw text to `generate-brief-background.js`. Netlify auto-responds 202 for `-background` suffixed functions, so long AI generations never hit the ~10s synchronous timeout.
2. The background function runs the pipeline: rate-limit check, PII scrub, draft call, auditor call, result written to a Blob keyed by `jobId`.
3. Frontend polls `check-brief.js` every 2 seconds (up to ~90s) until the Blob reports `done` or `error`.

### Guardrails, in order of execution

- **Daily rate limit**: a Blob-backed counter caps total generations per day, keeping a public free tool's API spend bounded.
- **PII scrub before the API**: emails and phone numbers are stripped server-side with regex before any text reaches the AI. The user is told how many items were removed. Nothing pasted is stored beyond the generated brief.
- **Input cap**: raw text is truncated at 24,000 characters, enough for a genuinely messy day, hostile to abuse.

### The auditor pass

Two sequential AI calls, no framework:

- **Call 1 (drafter)**: triages the scrubbed notes into the brief structure (strict JSON).
- **Call 2 (auditor)**: receives both the raw notes and the draft, checks whether anything significant was dropped or invented, corrects the brief, and reports what it changed in `audit_flags`, which are shown to the user.

A brief that silently drops the one deadline that mattered is worse than no brief. The auditor exists because of that failure mode, and showing its flags keeps the system honest with its user.

## Environment variables (all three required)

| Variable | What it is |
|---|---|
| `ANTHROPIC_API_KEY` | Per-project Anthropic API key |
| `NETLIFY_SITE_ID` | This site's ID, from Project details |
| `NETLIFY_BLOBS_TOKEN` | Netlify Personal Access Token |

Note: `getStore()` must be called with explicit `siteID` and `token`. Relying on ambient environment configuration throws `"The environment has not been configured to use Netlify Blobs"` in this deployment setup.

## Run it locally

1. Clone this repo.
2. `npm install`
3. `netlify dev` (with the three env vars set in a `.env` file or the Netlify CLI)

Built by [Soumik Chatterjee](https://cosmik.work).
