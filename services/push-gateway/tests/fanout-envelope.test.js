/**
 * Unit test for the Windy Admin chat.message_fanout envelope.
 *
 * Regression guard: the ingest 422s human/agent events with no actor_id.
 * An earlier revision omitted actor_id and every fanout event was silently
 * rejected (fire-and-forget swallowed the 422) — invisible until the panel
 * showed nothing. Lock the contract here.
 */
const { buildFanoutEnvelope } = require('../routes/notify');

describe('chat.message_fanout envelope', () => {
  const env = buildFanoutEnvelope('chat.new_message', 'id-abc-123', {
    subscribersOnly: true, delivered: 0, devices: 0,
  });

  it('sets a non-empty actor_id (required by the ingest for human actors)', () => {
    expect(env.actor_type).toBe('human');
    expect(env.actor_id).toBe('id-abc-123');
    expect(env.actor_id).toBeTruthy();
  });

  it('is content-free — no title/body/deep_link/message keys in metadata', () => {
    const keys = Object.keys(env.metadata).join(',').toLowerCase();
    for (const banned of ['content', 'text', 'body', 'message', 'title', 'deep_link', 'prompt']) {
      expect(keys).not.toContain(banned);
    }
  });

  it('carries counts and the event kind', () => {
    const e2 = buildFanoutEnvelope('chat.new_message', 'u1', {
      subscribersOnly: false, delivered: 3, devices: 5,
    });
    expect(e2.metadata).toEqual({
      event_kind: 'chat.new_message', subscribers_only: false, delivered: 3, devices: 5,
    });
  });
});
