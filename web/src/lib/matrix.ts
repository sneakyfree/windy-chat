/** Matrix client wrapper using matrix-js-sdk */
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
  });
  return client;
}

export async function startSync() {
  if (!client) throw new Error('Matrix client not initialized');
  await client.startClient({ initialSyncLimit: 20 });
}

export function stopSync() {
  if (client) client.stopClient();
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

/** Send a text message */
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
