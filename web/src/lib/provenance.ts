/**
 * Room provenance classifier — the shared primitive behind Hub Mode.
 *
 * There is ONE set of rooms; every Hub view (badges, solo-platform
 * filters, future groups) is a lens over that set, keyed by where a
 * conversation actually lives. This module answers that question for a
 * single room:
 *
 *   'native'   — a plain Windy Chat conversation
 *   'agent'    — a conversation with a Windy agent (existing convention:
 *                any member whose localpart starts with agent_ / windy_)
 *   'telegram' | 'slack' | 'whatsapp' | 'discord' — the conversation is
 *                linked in from that platform
 *
 * Detection order:
 *   1. `m.bridge` room state (the connector service stamps portal rooms
 *      with a protocol id; `uk.half-shot.bridge` is the legacy event
 *      name some connectors still emit) — authoritative when present.
 *   2. Member scan — ghost members are namespaced (@telegram_…,
 *      @slack_…, @whatsapp_…, @discord_…) and every portal room contains
 *      the platform's service account (@telegrambot:…, @slackbot:…, …).
 *   3. Agent convention (mirrors matrix.isAgentRoom).
 *   4. Otherwise native.
 *
 * NOTE (terminology): "bridge"/"Matrix" never appear in user-facing copy
 * — users see "Connected platforms". The protocol-level names only live
 * here, at the detection boundary.
 */
import type { MatrixEvent, Room } from 'matrix-js-sdk';

export type Provenance =
  | 'native'
  | 'agent'
  | 'telegram'
  | 'slack'
  | 'whatsapp'
  | 'discord';

/** External platforms we can classify (native/agent handled separately). */
export const KNOWN_PLATFORMS = ['telegram', 'slack', 'whatsapp', 'discord'] as const;
export type KnownPlatform = (typeof KNOWN_PLATFORMS)[number];

/** Display metadata (label + brand color) for the platform chips. */
export const PLATFORM_META: Record<string, { label: string; color: string }> = {
  telegram: { label: 'Telegram', color: '#2AABEE' },
  slack: { label: 'Slack', color: '#611f69' },
  whatsapp: { label: 'WhatsApp', color: '#25D366' },
  discord: { label: 'Discord', color: '#5865F2' },
};

/** Ghost-member MXID prefixes, one per platform (e.g. @telegram_12345:server). */
const PUPPET_PREFIXES: ReadonlyArray<readonly [string, KnownPlatform]> = [
  ['@telegram_', 'telegram'],
  ['@slack_', 'slack'],
  ['@whatsapp_', 'whatsapp'],
  ['@discord_', 'discord'],
];

/** Platform service-account localparts (e.g. @telegrambot:server). */
const SERVICE_BOT_PREFIXES: ReadonlyArray<readonly [string, KnownPlatform]> = [
  ['@telegrambot:', 'telegram'],
  ['@slackbot:', 'slack'],
  ['@whatsappbot:', 'whatsapp'],
  ['@discordbot:', 'discord'],
];

/** Agent-member convention — keep in sync with matrix.isAgentRoom. */
const AGENT_PREFIXES = ['@agent_', '@windy_'] as const;

const BRIDGE_STATE_TYPES = ['m.bridge', 'uk.half-shot.bridge'] as const;

/** Map a protocol id from room state to a known platform. */
export function platformFromProtocolId(id: unknown): KnownPlatform | null {
  if (typeof id !== 'string' || !id) return null;
  const norm = id.toLowerCase();
  for (const key of KNOWN_PLATFORMS) {
    // Exact or prefixed match ("telegram", "telegramgo", …).
    if (norm === key || norm.startsWith(key)) return key;
  }
  return null;
}

/** Classify a user id (MXID) in isolation. Exposed for message-level badging. */
export function classifyUserId(userId: string): Provenance {
  for (const [prefix, platform] of PUPPET_PREFIXES) {
    if (userId.startsWith(prefix)) return platform;
  }
  for (const [prefix, platform] of SERVICE_BOT_PREFIXES) {
    if (userId.startsWith(prefix)) return platform;
  }
  for (const prefix of AGENT_PREFIXES) {
    if (userId.startsWith(prefix)) return 'agent';
  }
  return 'native';
}

// Provenance is stable once a room is positively identified — cache the
// verdict per Room object so the room list doesn't re-scan member sets
// on every render tick. 'native' is NOT cached: a room can look native
// for a beat before its state/members finish syncing in.
const cache = new WeakMap<Room, Provenance>();

function computeProvenance(room: Room): Provenance {
  // 1. Room state stamped by the platform connector — authoritative.
  for (const type of BRIDGE_STATE_TYPES) {
    let events: MatrixEvent | MatrixEvent[] | null = null;
    try {
      events = room.currentState?.getStateEvents(type) ?? null;
    } catch {
      events = null;
    }
    const list = Array.isArray(events) ? events : events ? [events] : [];
    for (const ev of list) {
      const content = ev?.getContent?.() as { protocol?: { id?: unknown } } | undefined;
      const platform = platformFromProtocolId(content?.protocol?.id);
      if (platform) return platform;
    }
  }

  // 2 + 3. Member scan (invited members included — portal rooms can sit
  // in an invited state briefly before auto-join lands).
  let members: Array<{ userId: string }> = [];
  try {
    members = room.getMembers?.() ?? [];
  } catch {
    members = [];
  }
  let sawAgent = false;
  for (const member of members) {
    const verdict = classifyUserId(member.userId);
    if (verdict === 'agent') {
      sawAgent = true; // keep scanning — platform evidence outranks agent
    } else if (verdict !== 'native') {
      return verdict;
    }
  }
  if (sawAgent) return 'agent';

  return 'native';
}

/** Classify a room. Cached once positively identified. */
export function classifyRoom(room: Room): Provenance {
  const hit = cache.get(room);
  if (hit) return hit;
  const verdict = computeProvenance(room);
  if (verdict !== 'native') cache.set(room, verdict);
  return verdict;
}

/** Distinct provenances present in a room set (stable platform order). */
export function presentPlatforms(rooms: Room[]): KnownPlatform[] {
  const seen = new Set<Provenance>();
  for (const room of rooms) seen.add(classifyRoom(room));
  return KNOWN_PLATFORMS.filter((p) => seen.has(p));
}
