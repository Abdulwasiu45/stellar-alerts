'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import {
  AlertSeverity,
  SoundProfile,
  DEFAULT_SOUND_PROFILES,
  playSoundProfile,
  triggerScreenFlash,
  unlockAudioContext,
} from '@/lib/audio-synthesizer';

export const AUDIO_STUDIO_STORAGE_KEY = 'stellar_alerts_audio_studio_config';

export interface AudioStudioSettings {
  muted: boolean;
  masterVolume: number; // 0 - 100
  profiles: Record<AlertSeverity, SoundProfile>;
}

function loadInitialSettings(): AudioStudioSettings {
  if (typeof window === 'undefined') {
    return {
      muted: false,
      masterVolume: 80,
      profiles: { ...DEFAULT_SOUND_PROFILES },
    };
  }

  try {
    const raw = window.localStorage.getItem(AUDIO_STUDIO_STORAGE_KEY);
    if (!raw) {
      return {
        muted: false,
        masterVolume: 80,
        profiles: { ...DEFAULT_SOUND_PROFILES },
      };
    }
    const parsed = JSON.parse(raw);
    return {
      muted: Boolean(parsed.muted),
      masterVolume: typeof parsed.masterVolume === 'number' ? parsed.masterVolume : 80,
      profiles: {
        info: { ...DEFAULT_SOUND_PROFILES.info, ...(parsed.profiles?.info || {}) },
        warning: { ...DEFAULT_SOUND_PROFILES.warning, ...(parsed.profiles?.warning || {}) },
        critical: { ...DEFAULT_SOUND_PROFILES.critical, ...(parsed.profiles?.critical || {}) },
      },
    };
  } catch {
    return {
      muted: false,
      masterVolume: 80,
      profiles: { ...DEFAULT_SOUND_PROFILES },
    };
  }
}

export function useAlertSound() {
  const [settings, setSettings] = useState<AudioStudioSettings>(loadInitialSettings);
  const settingsRef = useRef(settings);

  useEffect(() => {
    settingsRef.current = settings;
    try {
      if (typeof window !== 'undefined') {
        window.localStorage.setItem(AUDIO_STUDIO_STORAGE_KEY, JSON.stringify(settings));
      }
    } catch {
      // Ignore localStorage write error
    }
  }, [settings]);

  const toggleMuted = useCallback(() => {
    setSettings((prev) => ({ ...prev, muted: !prev.muted }));
  }, []);

  const setMuted = useCallback((muted: boolean) => {
    setSettings((prev) => ({ ...prev, muted }));
  }, []);

  const setMasterVolume = useCallback((volume: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(volume)));
    setSettings((prev) => ({ ...prev, masterVolume: clamped }));
  }, []);

  const updateProfile = useCallback(
    (severity: AlertSeverity, updates: Partial<SoundProfile>) => {
      setSettings((prev) => ({
        ...prev,
        profiles: {
          ...prev.profiles,
          [severity]: {
            ...prev.profiles[severity],
            ...updates,
          },
        },
      }));
    },
    []
  );

  const resetToDefaults = useCallback(() => {
    setSettings({
      muted: false,
      masterVolume: 80,
      profiles: { ...DEFAULT_SOUND_PROFILES },
    });
  }, []);

  /**
   * Preview a sound and optional screen flash regardless of muted state
   */
  const previewAlert = useCallback(
    async (severity: AlertSeverity): Promise<void> => {
      await unlockAudioContext();
      const profile = settingsRef.current.profiles[severity];
      if (!profile) return;

      if (profile.flashScreen) {
        triggerScreenFlash(profile.flashColor, profile.flashDurationMs);
      }

      await playSoundProfile(profile, settingsRef.current.masterVolume);
    },
    []
  );

  /**
   * Trigger an alert sound & flash during actual operational notifications
   */
  const triggerAlert = useCallback(
    async (severity: AlertSeverity = 'info'): Promise<void> => {
      if (settingsRef.current.muted) return;
      await previewAlert(severity);
    },
    [previewAlert]
  );

  return {
    muted: settings.muted,
    masterVolume: settings.masterVolume,
    profiles: settings.profiles,
    toggleMuted,
    setMuted,
    setMasterVolume,
    updateProfile,
    resetToDefaults,
    previewAlert,
    triggerAlert,
  };
}
