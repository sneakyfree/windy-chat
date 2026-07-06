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

async function callGroq(messages, systemPrompt, tools, toolChoice) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  const body = {
    model: 'llama-3.3-70b-versatile',
    max_tokens: 512,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
  };
  if (tools && tools.length) {
    body.tools = tools;
    // 'none' is used on the post-tool synthesis pass: the tool schema
    // stays visible (which also keeps the Anthropic-skip guard engaged —
    // role:'tool' messages are OpenAI-shaped and would 400 on Anthropic),
    // but the model must answer in text instead of chaining another call.
    body.tool_choice = toolChoice || 'auto';
  }
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`groq ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  // Return the full message object so the caller can inspect tool_calls.
  // Groq's OpenAI-shape includes role/content/tool_calls.
  return msg || null;
}

function buildSystemPrompt({ agentName, ownerDisplayName, hasTools, canMail, canSearch }) {
  // Back-compat: callers that only know the old boolean get the mail
  // guidance (the Day-5 behavior, where hasTools ⇔ mail was configured).
  if (canMail === undefined && canSearch === undefined) {
    canMail = !!hasTools;
    canSearch = false;
  }
  const base = `${DEFAULT_SYSTEM_PROMPT}

Your name is ${agentName || 'your Windy Fly agent'}. The person messaging you is ${ownerDisplayName || 'your owner'}. You remember the conversation so far; refer back to earlier messages naturally when helpful.`;
  let out = base;
  if (canMail) {
    out += `

You can send emails on behalf of the user via the send_email tool.
ALWAYS follow this two-step pattern:
  1. When the user asks to send an email, FIRST reply in chat with a
     plain-text draft: "Here's what I'll send — To: <addr>, Subject:
     <subject>, Body: <body>. Send it?" — and DO NOT call any tool.
  2. ONLY when the user explicitly confirms (e.g. 'yes', 'send it',
     'looks good') do you call the send_email tool.

If the user gives you an incomplete request (no recipient, missing
subject), ask for the missing pieces in chat — do not guess.`;
  }
  if (canSearch) {
    out += `

You can search the web via the web_search tool. Use it when the user
asks about current events, weather, prices, opening hours, or any fact
you are not certain of — do NOT guess at things that may have changed.
No confirmation needed for searches; just search and then answer in
plain, friendly English based on the results. Mention where the answer
came from in passing (e.g. "according to the BBC") when it helps.
If a search result includes a note addressed to you about the user's
web-access allowance, gently pass that along in your own words.`;
  }
  return out;
}

/**
 * Generate a reply.
 *
 * @param {Object} opts
 * @param {Array<{role,content,tool_call_id?,name?}>} opts.history — chat history
 * @param {string} opts.agentName
 * @param {string} opts.ownerDisplayName
 * @param {Array} opts.tools — OpenAI-shaped tool definitions (optional)
 *
 * Returns the full LLM message: { role:'assistant', content, tool_calls? }.
 * The runner inspects tool_calls to decide whether to execute side-effects.
 */
async function generateReply({ history, agentName, ownerDisplayName, tools, toolChoice, canMail, canSearch }) {
  const systemPrompt = buildSystemPrompt({
    agentName,
    ownerDisplayName,
    hasTools: !!(tools && tools.length),
    canMail,
    canSearch,
  });

  // Trim to last 10 turns for token budget.
  const trimmed = history.slice(-10);

  // Anthropic doesn't share OpenAI's tool schema; skip Anthropic when tools
  // are required and fall through to Groq. (BYOM with Anthropic native
  // tool-calling lands when sk-ant-api03 keys land.)
  if (!tools || !tools.length) {
    try {
      const reply = await callAnthropic(trimmed, systemPrompt);
      if (reply) {
        return { role: 'assistant', content: reply, provider: 'anthropic' };
      }
    } catch (err) {
      console.warn(`[llm] anthropic failed: ${err.message}`);
    }
  }

  // Groq with optional tools
  try {
    const msg = await callGroq(trimmed, systemPrompt, tools, toolChoice);
    if (msg) {
      return { ...msg, provider: 'groq' };
    }
  } catch (err) {
    console.warn(`[llm] groq failed: ${err.message}`);
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('No LLM provider configured (ANTHROPIC_API_KEY / GROQ_API_KEY)');
  }
  const last = trimmed[trimmed.length - 1]?.content || '';
  return {
    role: 'assistant',
    content: `(dev stub) Heard: "${last.slice(0, 100)}". Configure an LLM key to get real responses.`,
    provider: 'stub',
  };
}

module.exports = { generateReply, DEFAULT_SYSTEM_PROMPT };
