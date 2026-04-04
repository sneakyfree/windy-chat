/** Voice input hook using Web Speech API (Option A) */
import { useState, useRef, useCallback } from 'react';

interface VoiceInputState {
  isRecording: boolean;
  transcript: string;
  error: string | null;
}

// Silence detection: auto-stop after N ms of no new speech
const SILENCE_TIMEOUT_MS = 3000;

export function useVoiceInput() {
  const [state, setState] = useState<VoiceInputState>({
    isRecording: false,
    transcript: '',
    error: null,
  });

  const recognitionRef = useRef<any>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isSupported = typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

  const resetSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = setTimeout(() => {
      stop();
    }, SILENCE_TIMEOUT_MS);
  }, []);

  const start = useCallback(() => {
    if (!isSupported) {
      setState(s => ({ ...s, error: 'Speech recognition not supported in this browser' }));
      return;
    }

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';

    let finalTranscript = '';

    recognition.onresult = (event: any) => {
      resetSilenceTimer();
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript + ' ';
        } else {
          interim += result[0].transcript;
        }
      }
      setState(s => ({
        ...s,
        transcript: (finalTranscript + interim).trim(),
      }));
    };

    recognition.onerror = (event: any) => {
      if (event.error !== 'aborted') {
        setState(s => ({ ...s, error: `Speech error: ${event.error}`, isRecording: false }));
      }
    };

    recognition.onend = () => {
      setState(s => ({ ...s, isRecording: false }));
      if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    };

    recognitionRef.current = recognition;
    recognition.start();
    resetSilenceTimer();
    setState({ isRecording: true, transcript: '', error: null });
  }, [isSupported, resetSilenceTimer]);

  const stop = useCallback(() => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
      recognitionRef.current = null;
    }
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
    setState(s => ({ ...s, isRecording: false }));
  }, []);

  const clear = useCallback(() => {
    setState(s => ({ ...s, transcript: '', error: null }));
  }, []);

  return {
    ...state,
    isSupported,
    start,
    stop,
    clear,
  };
}
