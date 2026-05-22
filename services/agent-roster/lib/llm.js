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

async function callAnthropic(messages, systemPrompt) {
  // sk-ant-api03 keys only — never sk-ant-oat01 OAuth tokens. OAuth at
  // multi-user scale is a Claude Code ToS violation per the lockbox memo.
  // Per-user BYOM keys land here when wired (Day 5+).
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey || !apiKey.startsWith('sk-ant-api')) return null;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      system: systemPrompt,
      messages,
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

async function callGroq(messages, systemPrompt) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 512,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
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
 * Generate a reply.
 *
 * @param {Object} opts
 * @param {Array<{role:'user'|'assistant', content:string}>} opts.history
 *   Conversation history with the current user turn as the LAST element.
 *   The agent runner pulls this from Matrix /messages and converts.
 * @param {string} opts.agentName — agent's display name (personalises system prompt)
 * @param {string} opts.ownerDisplayName — owner's display name (if known)
 *
 * Returns { text, provider }. Throws in production if every provider fails.
 */
async function generateReply({ history, agentName, ownerDisplayName }) {
  const systemPrompt = `${DEFAULT_SYSTEM_PROMPT}

Your name is ${agentName || 'your Windy Fly agent'}. The person messaging you is ${ownerDisplayName || 'your owner'}. You remember the conversation so far; refer back to earlier messages naturally when helpful.`;

  // Convert history to the standard chat-completions shape.
  // Anthropic API takes its own messages array; Groq takes OpenAI-style.
  // Both share role + content; trim to last 10 turns for token budget.
  const trimmed = history.slice(-10);

  // Anthropic (preferred when API key is sk-ant-api03)
  try {
    const reply = await callAnthropic(trimmed, systemPrompt);
    if (reply) return { text: reply, provider: 'anthropic' };
  } catch (err) {
    console.warn(`[llm] anthropic failed: ${err.message}`);
  }

  // Groq fallback (default workhorse)
  try {
    const reply = await callGroq(trimmed, systemPrompt);
    if (reply) return { text: reply, provider: 'groq' };
  } catch (err) {
    console.warn(`[llm] groq failed: ${err.message}`);
  }

  // Stub — only acceptable outside production
  if (process.env.NODE_ENV === 'production') {
    throw new Error('No LLM provider configured (ANTHROPIC_API_KEY / GROQ_API_KEY)');
  }
  const last = trimmed[trimmed.length - 1]?.content || '';
  return {
    text: `(dev stub) Heard: "${last.slice(0, 100)}". Configure an LLM key to get real responses.`,
    provider: 'stub',
  };
}

module.exports = { generateReply, DEFAULT_SYSTEM_PROMPT };
