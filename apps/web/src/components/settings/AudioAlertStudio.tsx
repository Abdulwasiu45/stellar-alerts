'use client';

import React, { useState } from 'react';
import { useAlertSound } from '@/hooks/useAlertSound';
import {
  AlertSeverity,
  OscillatorWaveform,
  SoundProfile,
} from '@/lib/audio-synthesizer';

const WAVEFORMS: { value: OscillatorWaveform; label: string; icon: string }[] = [
  { value: 'sine', label: 'Sine (Smooth & Gentle)', icon: '∿' },
  { value: 'triangle', label: 'Triangle (Warm & Clear)', icon: '▲' },
  { value: 'square', label: 'Square (Sharp & Punchy)', icon: '⊓' },
  { value: 'sawtooth', label: 'Sawtooth (Urgent & Piercing)', icon: '⩘' },
];

const SEVERITY_CONFIG: Record<
  AlertSeverity,
  { label: string; color: string; badgeClass: string; borderClass: string }
> = {
  info: {
    label: 'Info Alert',
    color: '#06b6d4',
    badgeClass: 'bg-cyan-500/20 text-cyan-300 border-cyan-500/40',
    borderClass: 'border-cyan-500/30',
  },
  warning: {
    label: 'Warning Alert',
    color: '#f59e0b',
    badgeClass: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
    borderClass: 'border-amber-500/30',
  },
  critical: {
    label: 'Critical Alert',
    color: '#ef4444',
    badgeClass: 'bg-red-500/20 text-red-300 border-red-500/40',
    borderClass: 'border-red-500/30',
  },
};

export const AudioAlertStudio: React.FC = () => {
  const {
    muted,
    masterVolume,
    profiles,
    toggleMuted,
    setMasterVolume,
    updateProfile,
    resetToDefaults,
    previewAlert,
  } = useAlertSound();

  const [activeSeverity, setActiveSeverity] = useState<AlertSeverity>('info');
  const [isPlayingPreview, setIsPlayingPreview] = useState(false);

  const activeProfile = profiles[activeSeverity];
  const severityMeta = SEVERITY_CONFIG[activeSeverity];

  const handlePreview = async (sev: AlertSeverity) => {
    setIsPlayingPreview(true);
    try {
      await previewAlert(sev);
    } finally {
      setIsPlayingPreview(false);
    }
  };

  const handleFrequenciesChange = (str: string) => {
    const parsed = str
      .split(',')
      .map((s) => parseFloat(s.trim()))
      .filter((n) => !Number.isNaN(n) && n > 20 && n < 20000);

    if (parsed.length > 0) {
      updateProfile(activeSeverity, { frequencies: parsed });
    }
  };

  return (
    <div
      data-testid="audio-alert-studio"
      className="bg-[#0b0c16] border border-white/10 rounded-3xl p-6 sm:p-8 shadow-2xl space-y-6"
    >
      {/* Studio Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 pb-6 border-b border-white/10">
        <div>
          <h2 className="text-xl sm:text-2xl font-extrabold text-white tracking-tight flex items-center gap-2">
            <span className="text-xl">🎛️</span>
            Audio-Visual Alert Studio
          </h2>
          <p className="text-gray-400 text-xs sm:text-sm mt-1">
            Synthesize custom frequency chimes via Web Audio API and configure screen flash cues per severity.
          </p>
        </div>

        {/* Global Controls: Mute & Master Volume */}
        <div className="flex items-center gap-4 bg-[#07080e] p-2.5 rounded-2xl border border-white/10">
          <button
            type="button"
            onClick={toggleMuted}
            aria-label={muted ? 'Unmute alerts' : 'Mute all alerts'}
            className={`px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all flex items-center gap-2 cursor-pointer ${
              muted
                ? 'bg-red-500/20 text-red-300 border border-red-500/40 shadow-[0_0_12px_rgba(239,68,68,0.3)]'
                : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
            }`}
          >
            <span>{muted ? '🔇 Muted' : '🔊 Sound Enabled'}</span>
          </button>

          <div className="flex items-center gap-2 pr-2">
            <span className="text-xs text-gray-400">Vol:</span>
            <input
              type="range"
              min="0"
              max="100"
              value={masterVolume}
              onChange={(e) => setMasterVolume(Number(e.target.value))}
              className="w-20 sm:w-24 accent-cyan-400 cursor-pointer"
              aria-label="Master volume"
            />
            <span className="text-xs font-mono text-cyan-300 w-8">{masterVolume}%</span>
          </div>

          <button
            type="button"
            onClick={resetToDefaults}
            title="Reset sound profiles to defaults"
            className="text-xs text-gray-400 hover:text-white px-2 py-1 rounded-lg hover:bg-white/5 transition-colors cursor-pointer"
          >
            Reset
          </button>
        </div>
      </div>

      {/* Severity Selector Tabs */}
      <div className="flex flex-wrap gap-2">
        {(['info', 'warning', 'critical'] as AlertSeverity[]).map((sev) => {
          const cfg = SEVERITY_CONFIG[sev];
          const isSelected = activeSeverity === sev;
          return (
            <button
              key={sev}
              type="button"
              onClick={() => setActiveSeverity(sev)}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition-all border cursor-pointer flex items-center gap-2 ${
                isSelected
                  ? `${cfg.badgeClass} shadow-md scale-102`
                  : 'bg-white/5 border-white/5 text-gray-400 hover:text-gray-200 hover:bg-white/10'
              }`}
            >
              <span
                className="w-2 h-2 rounded-full"
                style={{ backgroundColor: cfg.color }}
              />
              {cfg.label}
            </button>
          );
        })}
      </div>

      {/* Profile Configuration Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 bg-[#0f1120] p-5 sm:p-6 rounded-2xl border border-white/5">
        {/* Left Column: Sound Synthesizer Parameters */}
        <div className="space-y-5">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-bold text-white flex items-center gap-2">
              <span>Synthesizer Waveform & Pitch</span>
            </h3>
            <span className={`text-[11px] px-2 py-0.5 rounded-md border ${severityMeta.badgeClass}`}>
              {activeProfile.name}
            </span>
          </div>

          {/* Waveform Selector */}
          <div>
            <label className="block text-xs font-semibold text-gray-400 mb-2">
              Oscillator Waveform
            </label>
            <div className="grid grid-cols-2 gap-2">
              {WAVEFORMS.map((wf) => (
                <button
                  key={wf.value}
                  type="button"
                  onClick={() => updateProfile(activeSeverity, { waveform: wf.value })}
                  className={`p-2.5 rounded-xl text-xs font-semibold border text-left transition-all cursor-pointer flex items-center gap-2 ${
                    activeProfile.waveform === wf.value
                      ? 'bg-cyan-500/20 border-cyan-400 text-cyan-200'
                      : 'bg-[#090a12] border-white/10 text-gray-400 hover:text-white'
                  }`}
                >
                  <span className="text-base font-mono">{wf.icon}</span>
                  <span>{wf.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Frequency Sequence */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-semibold text-gray-400">
                Frequencies (Hz sequence, comma-separated)
              </label>
              <span className="text-[11px] font-mono text-cyan-300">
                {activeProfile.frequencies.join(', ')} Hz
              </span>
            </div>
            <input
              type="text"
              value={activeProfile.frequencies.join(', ')}
              onChange={(e) => handleFrequenciesChange(e.target.value)}
              className="w-full px-3.5 py-2 rounded-xl bg-[#07080e] border border-white/10 text-xs font-mono text-white focus:outline-none focus:border-cyan-400"
              placeholder="e.g. 523.25, 659.25, 783.99"
            />
            <p className="text-[10px] text-gray-500 mt-1">
              Supports single tones, arpeggiated chords, or siren frequencies.
            </p>
          </div>

          {/* Note Duration & Interval Sliders */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <div className="flex justify-between text-xs text-gray-400 mb-1">
                <span>Note Duration</span>
                <span className="font-mono text-cyan-300">{activeProfile.duration}s</span>
              </div>
              <input
                type="range"
                min="0.05"
                max="0.8"
                step="0.01"
                value={activeProfile.duration}
                onChange={(e) =>
                  updateProfile(activeSeverity, { duration: parseFloat(e.target.value) })
                }
                className="w-full accent-cyan-400 cursor-pointer"
              />
            </div>

            <div>
              <div className="flex justify-between text-xs text-gray-400 mb-1">
                <span>Tone Interval</span>
                <span className="font-mono text-cyan-300">{activeProfile.interval}s</span>
              </div>
              <input
                type="range"
                min="0.02"
                max="0.3"
                step="0.01"
                value={activeProfile.interval}
                onChange={(e) =>
                  updateProfile(activeSeverity, { interval: parseFloat(e.target.value) })
                }
                className="w-full accent-cyan-400 cursor-pointer"
              />
            </div>
          </div>
        </div>

        {/* Right Column: Visual Screen Flash & Live Preview */}
        <div className="space-y-5">
          <h3 className="text-sm font-bold text-white">Visual Screen Flash Alert</h3>

          {/* Screen Flash Toggle */}
          <div className="flex items-center justify-between p-3.5 rounded-xl bg-[#090a12] border border-white/10">
            <div>
              <div className="text-xs font-semibold text-white">Flash Screen on Trigger</div>
              <div className="text-[11px] text-gray-400">
                Flashes the browser viewport border/overlay for NOC operators
              </div>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={activeProfile.flashScreen}
                onChange={(e) =>
                  updateProfile(activeSeverity, { flashScreen: e.target.checked })
                }
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-gray-700 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-cyan-500"></div>
            </label>
          </div>

          {/* Flash Color & Duration */}
          <div>
            <div className="flex justify-between text-xs text-gray-400 mb-1">
              <span>Flash Duration</span>
              <span className="font-mono text-cyan-300">{activeProfile.flashDurationMs} ms</span>
            </div>
            <input
              type="range"
              min="100"
              max="1500"
              step="50"
              value={activeProfile.flashDurationMs}
              onChange={(e) =>
                updateProfile(activeSeverity, { flashDurationMs: parseInt(e.target.value) })
              }
              className="w-full accent-cyan-400 cursor-pointer"
            />
          </div>

          {/* Flash Color Swatch */}
          <div>
            <label className="block text-xs font-semibold text-gray-400 mb-1">
              Screen Flash Tint
            </label>
            <div className="flex items-center gap-3">
              <div
                className="w-8 h-8 rounded-lg border border-white/20 shadow-inner"
                style={{ backgroundColor: activeProfile.flashColor }}
              />
              <input
                type="text"
                value={activeProfile.flashColor}
                onChange={(e) =>
                  updateProfile(activeSeverity, { flashColor: e.target.value })
                }
                className="flex-1 px-3 py-1.5 rounded-xl bg-[#07080e] border border-white/10 text-xs font-mono text-white focus:outline-none focus:border-cyan-400"
              />
            </div>
          </div>

          {/* Preview Trigger Button */}
          <div className="pt-4">
            <button
              type="button"
              disabled={isPlayingPreview}
              onClick={() => handlePreview(activeSeverity)}
              className="w-full py-3 rounded-2xl bg-gradient-to-r from-cyan-500 via-blue-500 to-indigo-600 hover:opacity-95 text-black font-extrabold text-xs transition-all shadow-[0_0_20px_rgba(6,182,212,0.4)] flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50"
            >
              {isPlayingPreview ? (
                <>
                  <span className="w-3.5 h-3.5 border-2 border-black border-t-transparent rounded-full animate-spin"></span>
                  <span>Synthesizing Chime...</span>
                </>
              ) : (
                <>
                  <svg className="w-4 h-4 fill-current" viewBox="0 0 24 24">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                  <span>Preview {severityMeta.label} Sound & Flash</span>
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
