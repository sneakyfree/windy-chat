/**
 * LLM client — generates the agent's reply.
 *
 * Provider precedence:
 *   1. Anthropic Claude (if ANTHROPIC_API_KEY set) — sharpest, costliest
 *   2. Groq llama-3.3-70b (if GROQ_API_KEY set) — fast + free-tier
 *   3. Stub echo (development fallback only)
 *
 * Why two providers: Anthropic gives the highest-quality grandma replies,
 * but the free-tier Groq key is a graceful degradation so a quota hit
 * doesn't leave the user staring at a dead chat window. The stub exists
 * for local dev and CI; in production NODE_ENV=production with no real
 * key configured throws on boot so the service can't pretend to work.
 */

const DEFAULT_SYSTEM_PROMPT = `You are a personal AI agent for a Windy ecosystem user. You're chatting with them in their private Matrix room. They're not technical — they're a grandma, a busy professional, anyone — so reply in plain English without jargon. Keep replies short (1-3 sentences) unless they explicitly ask for more detail. Be warm and helpful. If they ask you to do something you can't yet (send mail, schedule, search), say "I'm still learning that — for now I can chat and help you think things through" rather than apologizing repeatedly.`;

async function callAnthropic(userText, opts) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: opts.model || 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: opts.systemPrompt || DEFAULT_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userText }],
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`anthropic ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text || null;
}

async function callGroq(userText, opts) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: opts.model || 'llama-3.3-70b-versatile',
      max_tokens: 512,
      messages: [
        { role: 'system', content: opts.systemPrompt || DEFAULT_SYSTEM_PROMPT },
        { role: 'user', content: userText },
      ],
    }),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`groq ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  return data.choices?.[0]?.message?.content || null;
}

/**
 * Generate a reply. Tries providers in precedence order, falls through to
 * stub in non-production environments.
 */
async function generateReply({ userText, agentName, ownerDisplayName }) {
  const systemPrompt = `${DEFAULT_SYSTEM_PROMPT}\n\nYour name is ${agentName || 'your Windy Fly agent'}. The person messaging you is ${ownerDisplayName || 'your owner'}.`;
  const opts = { systemPrompt };

  // Anthropic first
  try {
    const reply = await callAnthropic(userText, opts);
    if (reply) return { text: reply, provider: 'anthropic' };
  } catch (err) {
    console.warn(`[llm] anthropic failed: ${err.message}`);
  }

  // Groq fallback
  try {
    const reply = await callGroq(userText, opts);
    if (reply) return { text: reply, provider: 'groq' };
  } catch (err) {
    console.warn(`[llm] groq failed: ${err.message}`);
  }

  // Stub — only acceptable outside production
  if (process.env.NODE_ENV === 'production') {
    throw new Error('No LLM provider configured (ANTHROPIC_API_KEY and GROQ_API_KEY both unset in production)');
  }
  return {
    text: `(dev stub) I heard you say: "${userText.slice(0, 100)}". Configure an LLM key to get real responses.`,
    provider: 'stub',
  };
}

module.exports = { generateReply, DEFAULT_SYSTEM_PROMPT };
