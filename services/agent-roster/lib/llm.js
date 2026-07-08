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
  const text = data.content?.[0]?.text || null;
  if (!text) return null;
  return {
    text,
    model: data.model || 'claude-haiku-4-5-20251001',
    usage: {
      tokens_in: data.usage?.input_tokens ?? null,
      tokens_out: data.usage?.output_tokens ?? null,
    },
  };
}

// Phase 1.5 (ADR-WA-001 §8): the midwife's brain routes through Windy
// Mind so the model is an operator-set config ("midwife" surface), not
// a redeploy. Mind resolves the surface server-side; Groq-direct below
// stays as the availability fallback (a silent agent is worse than a
// duplicate voice). Auth = the agent's own EPT (per-passport EI rate
// limits + audit attribution on Mind's side).
const MIND_SURFACE = process.env.MIND_CHAT_SURFACE || 'midwife';

/**
 * Some models (seen live 2026-07-08: gemini-2.5-flash via Mind) sometimes
 * emit their tool call as pseudo-markup INSIDE content instead of the
 * structured tool_calls array — e.g.
 *   <function(web_search){"query": "tips for keeping roses healthy"}</function>
 * Without interception the runner's plain-text path posts that markup
 * verbatim into grandma's DM and the tool never runs.
 *
 * Salvage: extract the intended call into a real tool_calls entry and
 * strip the markup from content. If the markup is unparseable, scrub it
 * and answer with an honest "hiccup — ask me again" instead of gibberish.
 */
const TOOL_MARKUP_RE = /<\/?function[\s=(>]|<\/?tool_call>/;
const FUNCTION_LEAK_RE = /<function[\s=(]*([a-zA-Z0-9_]+)[)>]*\s*(\{[\s\S]*?\})\s*(?:<\/function>|$)/;
const TOOL_CALL_LEAK_RE = /<tool_call>\s*(\{[\s\S]*?\})\s*(?:<\/tool_call>|$)/;
const SCRUBBED_FALLBACK = "I hit a little snag using one of my tools just now — could you ask me that one more time?";

function salvageLeakedToolCalls(msg) {
  if (!msg || (Array.isArray(msg.tool_calls) && msg.tool_calls.length)) return msg;
  const content = msg.content;
  if (typeof content !== 'string' || !TOOL_MARKUP_RE.test(content)) return msg;

  let name = null;
  let argsStr = null;
  let matched = null;
  let m = content.match(FUNCTION_LEAK_RE);
  if (m) {
    [matched, name, argsStr] = m;
  } else {
    m = content.match(TOOL_CALL_LEAK_RE);
    if (m) {
      matched = m[0];
      try {
        const parsed = JSON.parse(m[1]);
        name = parsed.name || parsed.function || null;
        argsStr = JSON.stringify(parsed.arguments ?? parsed.parameters ?? {});
      } catch { /* fall through to scrub */ }
    }
  }

  let argsValid = false;
  if (name && argsStr) {
    try { JSON.parse(argsStr); argsValid = true; } catch { /* scrub */ }
  }

  if (argsValid) {
    const remainder = content.replace(matched, '').trim();
    console.warn(`[llm] salvaged leaked tool markup → ${name}`);
    return {
      ...msg,
      content: remainder,
      tool_calls: [{
        id: `salvaged-${Date.now()}`,
        type: 'function',
        function: { name, arguments: argsStr },
      }],
    };
  }
  console.warn('[llm] scrubbed unparseable leaked tool markup');
  return { ...msg, content: SCRUBBED_FALLBACK };
}

async function callMind(messages, systemPrompt, tools, toolChoice, ept) {
  if (!ept || process.env.ROSTER_MIND_DISABLE === '1') return null;
  const base = (process.env.MIND_API_URL || 'https://api.windymind.ai').replace(/\/$/, '');
  const body = {
    surface: MIND_SURFACE,
    max_tokens: 512,
    messages: [
      { role: 'system', content: systemPrompt },
      ...messages,
    ],
  };
  if (tools && tools.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || 'auto';
  }
  const res = await fetch(`${base}/v1/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ept}`,
    },
    body: JSON.stringify(body),
    // Mind adds a broker hop on top of the provider call.
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`mind ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  if (!msg) return null;
  // Mind reports the RESOLVED model (the A/B dimension) + usage.
  msg.model = data.model || null;
  msg.usage = {
    tokens_in: data.usage?.prompt_tokens ?? null,
    tokens_out: data.usage?.completion_tokens ?? null,
  };
  return salvageLeakedToolCalls(msg);
}

const GROQ_MODEL = 'llama-3.3-70b-versatile';
// Groq rate limits are PER-MODEL: when the shared free-tier key burns its
// daily tokens on the primary model (seen live 2026-07-06: TPD 100k
// exhausted → every fly dead until reset), the 8b model still has its own
// untouched quota. Weaker answers beat a dead chat for the rest of the day.
const GROQ_FALLBACK_MODEL = 'llama-3.1-8b-instant';

async function callGroq(messages, systemPrompt, tools, toolChoice, model) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  const body = {
    model: model || GROQ_MODEL,
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
  if (!msg) return null;
  // Return the full message object so the caller can inspect tool_calls.
  // Groq's OpenAI-shape includes role/content/tool_calls. Attach the
  // resolved model + token usage for the Windy Admin ledger (the model
  // matters: it's the midwife A/B dimension, ADR-WA-001 §8).
  msg.model = data.model || model || GROQ_MODEL;
  msg.usage = {
    tokens_in: data.usage?.prompt_tokens ?? null,
    tokens_out: data.usage?.completion_tokens ?? null,
  };
  return salvageLeakedToolCalls(msg);
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
async function generateReply({ history, agentName, ownerDisplayName, tools, toolChoice, canMail, canSearch, ept }) {
  const systemPrompt = buildSystemPrompt({
    agentName,
    ownerDisplayName,
    hasTools: !!(tools && tools.length),
    canMail,
    canSearch,
  });

  // Trim to last 10 turns for token budget.
  const trimmed = history.slice(-10);

  // Windy Mind first (Phase 1.5) — the model control plane decides the
  // midwife's model. Any failure falls through to the direct chain
  // below unchanged; availability first.
  try {
    const msg = await callMind(trimmed, systemPrompt, tools, toolChoice, ept);
    if (msg) {
      return { ...msg, provider: 'mind' };
    }
  } catch (err) {
    console.warn(`[llm] mind failed, falling back direct: ${err.message}`);
  }

  // Anthropic doesn't share OpenAI's tool schema; skip Anthropic when tools
  // are required and fall through to Groq. (BYOM with Anthropic native
  // tool-calling lands when sk-ant-api03 keys land.)
  if (!tools || !tools.length) {
    try {
      const reply = await callAnthropic(trimmed, systemPrompt);
      if (reply) {
        return {
          role: 'assistant',
          content: reply.text,
          provider: 'anthropic',
          model: reply.model,
          usage: reply.usage,
        };
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
    const msg = String(err.message);
    // llama tool-calling is stochastic: a malformed emission surfaces as
    // Groq 400 tool_use_failed (seen live 2026-07-06 on the first
    // web_search E2E). Retry once — usually clears — then drop tools and
    // answer text-only. A knowledge-only answer beats a dead chat.
    if (tools && tools.length && msg.includes('tool_use_failed')) {
      try {
        const retry = await callGroq(trimmed, systemPrompt, tools, toolChoice);
        if (retry) return { ...retry, provider: 'groq' };
      } catch (err2) {
        console.warn(`[llm] groq tool retry failed: ${err2.message}`);
      }
      try {
        const textOnly = await callGroq(trimmed, systemPrompt, null);
        if (textOnly) return { ...textOnly, provider: 'groq-notools' };
      } catch (err3) {
        console.warn(`[llm] groq no-tools fallback failed: ${err3.message}`);
      }
    }
    // Per-model rate limit (429): the fallback model has its own daily
    // quota — availability first.
    if (msg.includes('groq 429')) {
      try {
        const alt = await callGroq(trimmed, systemPrompt, tools, toolChoice, GROQ_FALLBACK_MODEL);
        if (alt) return { ...alt, provider: `groq:${GROQ_FALLBACK_MODEL}` };
      } catch (err4) {
        console.warn(`[llm] groq fallback model failed: ${err4.message}`);
        try {
          const altPlain = await callGroq(trimmed, systemPrompt, null, undefined, GROQ_FALLBACK_MODEL);
          if (altPlain) return { ...altPlain, provider: `groq:${GROQ_FALLBACK_MODEL}-notools` };
        } catch (err5) {
          console.warn(`[llm] groq fallback no-tools failed: ${err5.message}`);
        }
      }
    }
  }

  if (process.env.NODE_ENV === 'production') {
    // Providers may be configured but all attempts failed this turn —
    // the runner catches this and sends the friendly snag message.
    throw new Error('All LLM attempts failed this turn (see [llm] warnings)');
  }
  const last = trimmed[trimmed.length - 1]?.content || '';
  return {
    role: 'assistant',
    content: `(dev stub) Heard: "${last.slice(0, 100)}". Configure an LLM key to get real responses.`,
    provider: 'stub',
  };
}

module.exports = { generateReply, DEFAULT_SYSTEM_PROMPT, salvageLeakedToolCalls };
