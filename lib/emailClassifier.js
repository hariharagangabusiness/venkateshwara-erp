// Tier 3 of the Service inbound-mail guardrail: one tiny LLM call, only
// reached after the free header checks and keyword pre-screen pass.
// Plain fetch (no SDK dependency). Returns 'SERVICE' | 'SPAM', or null when
// the AI is unavailable for ANY reason (no key, timeout, HTTP error, odd
// reply) - the caller then falls back to creating the SR for human approval,
// so a customer message is never lost to an outage.
const MODEL = 'claude-haiku-5-5';
const TIMEOUT_MS = 8000;
const MAX_BODY_CHARS = 2000; // cap input tokens per email

const SYSTEM = 'You screen emails sent to a machinery manufacturer\'s service desk. '
  + 'Reply with exactly one word: SERVICE if the sender is a real customer asking for service, repair, breakdown help, spares or an enquiry; '
  + 'SPAM for marketing, newsletters, phishing or anything else irrelevant. Output only that one word.';

async function classifyServiceEmail(subject, bodyText) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 5, system: SYSTEM,
        messages: [{ role: 'user', content: `Subject: ${subject || ''}\n\n${String(bodyText || '').slice(0, MAX_BODY_CHARS)}` }],
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const word = String((data.content && data.content[0] && data.content[0].text) || '').trim().toUpperCase();
    if (word === 'SERVICE' || word === 'SPAM') return word;
    throw new Error('unexpected reply: ' + word.slice(0, 20));
  } catch (e) {
    console.error('[emailClassifier] AI unavailable, falling back to SR creation:', e.message);
    return null;
  }
}

module.exports = { classifyServiceEmail };
