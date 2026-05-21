/** Matrix client wrapper using matrix-js-sdk with E2E encryption support */
import * as sdk from 'matrix-js-sdk';
import { env } from '../env';

let client: sdk.MatrixClient | null = null;

export function getClient(): sdk.MatrixClient | null {
  return client;
}

export function initClient(accessToken: string, userId: string): sdk.MatrixClient {
  client = sdk.createClient({
    baseUrl: env.matrixUrl,
    accessToken,
    userId,
    timelineSupport: true,
    // E2E encryption: matrix-js-sdk uses Rust crypto (Vodozemac) by default in v41+
    // Keys are stored in IndexedDB automatically
  });
  return client;
}

export async function startSync() {
  if (!client) throw new Error('Matrix client not initialized');

  // Initialize crypto (E2E encryption) if available
  try {
    await client.initRustCrypto();
    console.log('[matrix] E2E encryption initialized (Rust crypto)');
  } catch (err) {
    console.warn('[matrix] E2E crypto init failed (non-fatal):', err);
    // Crypto init can fail in some browsers — continue without E2E
  }

  await client.startClient({ initialSyncLimit: 20 });

  // Set presence to online
  try {
    client.setPresence({ presence: 'online' });
  } catch { /* non-fatal */ }
}

export function stopSync() {
  if (client) {
    try { client.setPresence({ presence: 'offline' }); } catch { /* ignore */ }
    client.stopClient();
  }
}

export function isLoggedIn(): boolean {
  return !!localStorage.getItem('matrix_access_token');
}

export function restoreSession(): sdk.MatrixClient | null {
  const accessToken = localStorage.getItem('matrix_access_token');
  const userId = localStorage.getItem('matrix_user_id');
  if (accessToken && userId) {
    return initClient(accessToken, userId);
  }
  return null;
}

export function saveSession(accessToken: string, userId: string) {
  localStorage.setItem('matrix_access_token', accessToken);
  localStorage.setItem('matrix_user_id', userId);
}

export function clearSession() {
  stopSync();
  localStorage.removeItem('matrix_access_token');
  localStorage.removeItem('matrix_user_id');
  client = null;
}

/** Get sorted rooms list */
export function getRooms(): sdk.Room[] {
  if (!client) return [];
  return client.getRooms()
    .filter(r => r.getMyMembership() === 'join')
    .sort((a, b) => {
      const tsA = a.getLastActiveTimestamp();
      const tsB = b.getLastActiveTimestamp();
      return tsB - tsA;
    });
}

/** Check if a room is an agent DM */
export function isAgentRoom(room: sdk.Room): boolean {
  const members = room.getJoinedMembers();
  return members.some(m => m.userId.startsWith('@agent_'));
}

/** Get unread count for a room */
export function getUnreadCount(room: sdk.Room): number {
  const counts = room.getUnreadNotificationCount();
  return counts || 0;
}

/** Send a text message (auto-encrypts in E2E rooms) */
export async function sendMessage(roomId: string, body: string) {
  if (!client) throw new Error('Not connected');
  return client.sendTextMessage(roomId, body);
}

/** Set typing indicator */
export function setTyping(roomId: string, typing: boolean) {
  if (!client) return;
  client.sendTyping(roomId, typing, typing ? 30000 : 0);
}

/** Set presence */
export function setPresence(presence: 'online' | 'unavailable' | 'offline') {
  if (!client) return;
  client.setPresence({ presence });
}

/** Check if a room is E2E encrypted */
export function isRoomEncrypted(roomId: string): boolean {
  if (!client) return false;
  return client.isRoomEncrypted(roomId);
}

/** Create a new DM room (or reuse an existing one with the same single invitee). */
export async function createDMRoom(targetMatrixId: string): Promise<string> {
  if (!client) throw new Error('Not connected');
  // Reuse if the user already has a DM with this person — repeatedly opening
  // "Message" from a profile would otherwise spawn duplicate rooms in the
  // sidebar. Matrix's m.direct account-data is the canonical signal but
  // syncing it across clients is fiddly; a member-set scan over already-
  // joined rooms is good enough for the common case.
  const me = client.getUserId();
  for (const room of client.getRooms()) {
    if (room.getMyMembership() !== 'join') continue;
    const members = room.getJoinedMembers();
    if (members.length !== 2) continue;
    const otherIds = members.map(m => m.userId).filter(id => id !== me);
    if (otherIds.length === 1 && otherIds[0] === targetMatrixId) {
      return room.roomId;
    }
  }
  const result = await client.createRoom({
    invite: [targetMatrixId],
    is_direct: true,
    preset: 'trusted_private_chat' as any,
    initial_state: [{
      type: 'm.room.guest_access',
      state_key: '',
      content: { guest_access: 'forbidden' },
    }],
  });
  return result.room_id;
}
