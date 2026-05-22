/**
 * Tool registry for the agent-roster.
 *
 * Day 5: send_email — the first agent capability that actually DOES
 * something rather than just chats. Grandma vision: "Send my doctor
 * an email saying I'll be late" → agent drafts → confirms → sends.
 *
 * The LLM emits OpenAI-style tool_calls. The runner intercepts each
 * call, executes it via the handler here, and either:
 *   - Reports the result back to the LLM for a summarising reply, OR
 *   - Posts the result directly to the room (for "side effect"
 *     confirmations like "Sent ✓")
 *
 * Always-confirm rule: the agent's system prompt is tuned so the LLM
 * drafts an email as a chat reply FIRST, then only calls send_email
 * after the user explicitly confirms. We don't enforce this in code —
 * the model is responsible for grandma-safe behaviour, and the system
 * prompt makes the contract explicit.
 *
 * Backend: Resend SMTP relay (YOLOTOKEN) is the tactical bridge until
 * windy-mail's delegation engine ships. Resend has verified
 * windymail.ai, so the From: header can be any <user>@windymail.ai.
 * The recipient sees the email coming from the operator's own address.
 */

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'send_email',
      description: "Send an email on the user's behalf. ONLY call this AFTER you have drafted the email as a chat reply and the user has explicitly confirmed (e.g. 'yes', 'send it', 'looks good'). Never call this on the first turn — always draft first.",
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: "Recipient email address (single address).",
          },
          subject: {
            type: 'string',
            description: 'Email subject line; one short sentence.',
          },
          body: {
            type: 'string',
            description: 'Email body in plain text. Keep it warm and human.',
          },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
];

/**
 * send_email — calls Resend's API to relay an email. Returns either
 * { ok: true, message_id, from } or { ok: false, error }.
 */
async function sendEmail({ to, subject, body, fromAddress, ownerDisplayName, agentName }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return { ok: false, error: 'No mail relay configured (RESEND_API_KEY missing). The agent can draft but not send right now.' };
  }
  if (!fromAddress) {
    return { ok: false, error: 'No mailbox address configured for your account. Open Settings → Mail → Connect to set one up.' };
  }
  // Defensive validation — the LLM occasionally hallucinates malformed
  // addresses. Cheap regex catches the obvious wrongs without trying to
  // be RFC 5322 (browsers + recipients tolerate more than the regex).
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    return { ok: false, error: `That recipient address (${to}) doesn't look valid. Want to give me a corrected one?` };
  }
  // Display-name wrap so the recipient sees something humane
  const fromName = ownerDisplayName || agentName || 'Windy user';
  const fromHeader = `${fromName} <${fromAddress}>`;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from: fromHeader,
        to,
        subject,
        text: body,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      return { ok: false, error: `Mail relay rejected (${res.status}): ${detail.slice(0, 200)}` };
    }
    const data = await res.json();
    return { ok: true, message_id: data.id || 'unknown', from: fromHeader };
  } catch (err) {
    return { ok: false, error: err?.message || 'Could not reach the mail relay.' };
  }
}

/**
 * Execute a tool by name. Returns { ok, ... } shape.
 */
async function executeTool(name, args, context) {
  if (name === 'send_email') {
    return sendEmail({
      to: args.to,
      subject: args.subject,
      body: args.body,
      fromAddress: context.ownerMailAddress,
      ownerDisplayName: context.ownerDisplayName,
      agentName: context.agentName,
    });
  }
  return { ok: false, error: `Unknown tool: ${name}` };
}

module.exports = { TOOLS, executeTool };
