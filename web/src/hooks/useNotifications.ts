/** Notification hook — sounds, browser notifications, title badge, favicon */
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import * as matrix from '../lib/matrix';

let audioContext: AudioContext | null = null;

function playChime() {
  try {
    if (!audioContext) audioContext = new AudioContext();
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.connect(gain);
    gain.connect(audioContext.destination);
    osc.frequency.setValueAtTime(880, audioContext.currentTime);
    osc.frequency.exponentialRampToValueAtTime(440, audioContext.currentTime + 0.15);
    gain.gain.setValueAtTime(0.15, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.3);
    osc.start(audioContext.currentTime);
    osc.stop(audioContext.currentTime + 0.3);
  } catch {
    // Audio not available — silent fallback
  }
}

export function useNotifications() {
  const [unreadTotal, setUnreadTotal] = useState(0);
  const [hasPermission, setHasPermission] = useState(false);
  const lastNotifiedRef = useRef<string | null>(null);
  const originalTitle = useRef(document.title);

  // Request notification permission
  const requestPermission = useCallback(async () => {
    if (!('Notification' in window)) return false;
    if (Notification.permission === 'granted') { setHasPermission(true); return true; }
    const result = await Notification.requestPermission();
    const granted = result === 'granted';
    setHasPermission(granted);
    return granted;
  }, []);

  // Update unread count from Matrix rooms
  useEffect(() => {
    const update = () => {
      const rooms = matrix.getRooms();
      let total = 0;
      for (const room of rooms) {
        total += matrix.getUnreadCount(room);
      }
      setUnreadTotal(total);
    };

    update();
    const interval = setInterval(update, 3000);

    const client = matrix.getClient();
    if (client) {
      client.on('Room.timeline' as any, update);
    }

    return () => {
      clearInterval(interval);
      if (client) client.removeListener('Room.timeline' as any, update);
    };
  }, []);

  // Update page title with unread count
  useEffect(() => {
    if (unreadTotal > 0) {
      document.title = `(${unreadTotal}) Windy Chat`;
    } else {
      document.title = originalTitle.current || 'Windy Chat';
    }
  }, [unreadTotal]);

  // Show browser notification for new messages
  const notifyNewMessage = useCallback((senderName: string, roomName: string, eventId: string) => {
    if (eventId === lastNotifiedRef.current) return;
    lastNotifiedRef.current = eventId;

    // Play sound
    if (document.hidden) {
      playChime();
    }

    // Browser notification (only when tab is not focused)
    if (document.hidden && hasPermission && 'Notification' in window) {
      new Notification(`${senderName}`, {
        body: 'New message', // Privacy: don't show content
        icon: '/icon-192.png',
        tag: roomName,
        silent: true, // We play our own sound
      });
    }
  }, [hasPermission]);

  // Memoize the returned object — consumers put it in useEffect deps
  // (ChatPage's message subscription), and a fresh object every render
  // makes those effects re-run each render. Combined with an
  // unconditional setState inside, that was an infinite
  // render→effect→setState loop ("Maximum update depth exceeded").
  return useMemo(() => ({
    unreadTotal,
    hasPermission,
    requestPermission,
    notifyNewMessage,
  }), [unreadTotal, hasPermission, requestPermission, notifyNewMessage]);
}
