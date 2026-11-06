import React, { useState, useEffect } from 'react';
import type { AppSettings, NotificationPermissionState } from '../types';
import { playAlertChime, unlockAudioContext } from '../utils/alertChime';
import {
  getNotificationPermissionStatus,
  requestNotificationPermission,
  sendCaregiverNotification,
} from '../utils/notificationService';

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSettingsSaved: (newSettings: AppSettings) => void;
  currentRoom: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  confidence_threshold: 0.4,
  duplicate_cooldown_sec: 4,
  continuous_grouping_window_sec: 12,
  activity_window_min: 15,
  alerts_critical_enabled: true,
  alerts_high_enabled: true,
  notifications_enabled: true,
  chime_enabled: false,
  chime_severity: 'Critical',
};

export default function SettingsModal({
  isOpen,
  onClose,
  onSettingsSaved,
  currentRoom,
}: SettingsModalProps) {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [isSaving, setIsSaving] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'sound' | 'events' | 'activities' | 'alerts'>('sound');
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermissionState>(
    getNotificationPermissionStatus()
  );
  const [testFeedback, setTestFeedback] = useState<string | null>(null);

  // Load settings whenever modal opens
  useEffect(() => {
    if (!isOpen) {
      setErrorMsg(null);
      setSuccessMsg(null);
      setTestFeedback(null);
      return;
    }

    let isMounted = true;
    setIsLoading(true);
    setErrorMsg(null);

    fetch('/api/settings')
      .then((res) => {
        if (!res.ok) throw new Error(`Server returned ${res.status}`);
        return res.json();
      })
      .then((data: Record<string, string>) => {
        if (!isMounted) return;
        const loaded: AppSettings = {
          confidence_threshold:
            data.confidence_threshold !== undefined
              ? parseFloat(data.confidence_threshold)
              : DEFAULT_SETTINGS.confidence_threshold,
          duplicate_cooldown_sec:
            data.duplicate_cooldown_sec !== undefined
              ? parseFloat(data.duplicate_cooldown_sec)
              : DEFAULT_SETTINGS.duplicate_cooldown_sec,
          continuous_grouping_window_sec:
            data.continuous_grouping_window_sec !== undefined
              ? parseFloat(data.continuous_grouping_window_sec)
              : DEFAULT_SETTINGS.continuous_grouping_window_sec,
          activity_window_min:
            data.activity_window_min !== undefined
              ? parseInt(data.activity_window_min, 10)
              : DEFAULT_SETTINGS.activity_window_min,
          alerts_critical_enabled: data.alerts_critical_enabled !== 'false',
          alerts_high_enabled: data.alerts_high_enabled !== 'false',
          notifications_enabled: data.notifications_enabled !== 'false',
          chime_enabled: data.chime_enabled === 'true',
          chime_severity:
            (data.chime_severity as 'Critical' | 'High') || DEFAULT_SETTINGS.chime_severity,
        };
        setSettings(loaded);
        setIsLoading(false);
      })
      .catch((err) => {
        if (!isMounted) return;
        console.warn('Failed to load settings from server:', err);
        setErrorMsg('Could not load settings from server. Displaying cached defaults.');
        setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [isOpen]);

  // Handle Escape key to close (unless saving)
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !isSaving) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, isSaving, onClose]);

  if (!isOpen) return null;

  // Validation
  const validateForm = (): string | null => {
    if (
      isNaN(settings.confidence_threshold) ||
      settings.confidence_threshold < 0.05 ||
      settings.confidence_threshold > 1.0
    ) {
      return 'Confidence threshold must be between 5% and 100%.';
    }
    if (
      isNaN(settings.duplicate_cooldown_sec) ||
      settings.duplicate_cooldown_sec < 1 ||
      settings.duplicate_cooldown_sec > 60
    ) {
      return 'Duplicate suppression cooldown must be between 1 and 60 seconds.';
    }
    if (
      isNaN(settings.continuous_grouping_window_sec) ||
      settings.continuous_grouping_window_sec < 2 ||
      settings.continuous_grouping_window_sec > 60
    ) {
      return 'Continuous sound grouping window must be between 2 and 60 seconds.';
    }
    if (
      isNaN(settings.activity_window_min) ||
      settings.activity_window_min < 3 ||
      settings.activity_window_min > 120
    ) {
      return 'Activity detection window must be between 3 and 120 minutes.';
    }
    return null;
  };

  const handleSave = async () => {
    const error = validateForm();
    if (error) {
      setErrorMsg(error);
      return;
    }

    setIsSaving(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    const payload = {
      settings: {
        confidence_threshold: settings.confidence_threshold.toFixed(2),
        duplicate_cooldown_sec: settings.duplicate_cooldown_sec.toString(),
        continuous_grouping_window_sec: settings.continuous_grouping_window_sec.toString(),
        activity_window_min: settings.activity_window_min.toString(),
        alerts_critical_enabled: settings.alerts_critical_enabled ? 'true' : 'false',
        alerts_high_enabled: settings.alerts_high_enabled ? 'true' : 'false',
        notifications_enabled: settings.notifications_enabled ? 'true' : 'false',
        chime_enabled: settings.chime_enabled ? 'true' : 'false',
        chime_severity: settings.chime_severity,
      },
    };

    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || `Server responded with ${res.status}`);
      }

      // Update client storage for notifications & chime for cross-tab sync
      localStorage.setItem('echotrace_notifications_enabled', String(settings.notifications_enabled));
      localStorage.setItem('echotrace_chime_enabled', String(settings.chime_enabled));
      localStorage.setItem('echotrace_chime_severity', settings.chime_severity);

      setSuccessMsg('✓ Settings saved successfully to SQLite database.');
      onSettingsSaved(settings);

      setTimeout(() => {
        setSuccessMsg(null);
        onClose();
      }, 900);
    } catch (err: any) {
      console.error('Failed to save settings:', err);
      setErrorMsg(`Failed to save settings: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const handleResetDefaults = () => {
    setSettings(DEFAULT_SETTINGS);
    setErrorMsg(null);
    setSuccessMsg('Defaults restored in form. Click Save to persist.');
    setTimeout(() => setSuccessMsg(null), 3000);
  };

  const handleRequestPermission = async () => {
    unlockAudioContext();
    const perm = await requestNotificationPermission();
    setNotificationPermission(perm);
    if (perm === 'granted') {
      setSettings((prev) => ({ ...prev, notifications_enabled: true }));
      setTestFeedback('✓ Browser notification permission granted.');
    } else {
      setTestFeedback('⚠ Permission denied in browser settings.');
    }
    setTimeout(() => setTestFeedback(null), 4000);
  };

  const handleTestChimeSound = () => {
    unlockAudioContext();
    playAlertChime();
    setTestFeedback('🔊 Melodic alert chime previewed.');
    setTimeout(() => setTestFeedback(null), 3000);
  };

  const handleTestBrowserNotification = () => {
    if (notificationPermission !== 'granted') {
      handleRequestPermission();
      return;
    }
    sendCaregiverNotification(
      {
        id: Date.now(),
        event_id: null,
        alert_type: 'Settings Test Verification',
        severity: 'Critical',
        description: 'Caregiver notification system test from EchoTrace Settings.',
        timestamp: new Date().toISOString(),
        acknowledged: 0,
        acknowledged_at: null,
        source: 'simulator',
        room: currentRoom,
      },
      () => {
        window.focus();
      }
    );
    if (settings.chime_enabled) {
      playAlertChime();
    }
    setTestFeedback('✓ Test alert notification sent to desktop.');
    setTimeout(() => setTestFeedback(null), 3500);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-modal-title"
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(10, 13, 18, 0.85)',
        backdropFilter: 'blur(4px)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '20px',
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !isSaving) onClose();
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: '680px',
          maxHeight: '90vh',
          backgroundColor: '#161b22',
          border: '1px solid #30363d',
          borderRadius: '12px',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '0 20px 40px rgba(0, 0, 0, 0.6)',
          overflow: 'hidden',
          color: '#e6edf3',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '18px 24px',
            borderBottom: '1px solid #30363d',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            backgroundColor: '#1c2128',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span style={{ fontSize: '1.3rem' }}>⚙️</span>
            <div>
              <h2
                id="settings-modal-title"
                style={{ margin: 0, fontSize: '1.2rem', fontWeight: 700, color: '#ffffff' }}
              >
                EchoTrace Settings
              </h2>
              <div style={{ fontSize: '0.78rem', color: '#8b949e', marginTop: '2px' }}>
                Configure sound classification, event smoothing, and caregiver alerts
              </div>
            </div>
          </div>
          <button
            onClick={() => !isSaving && onClose()}
            disabled={isSaving}
            aria-label="Close settings"
            style={{
              background: 'transparent',
              border: 'none',
              color: '#8b949e',
              fontSize: '1.25rem',
              cursor: isSaving ? 'not-allowed' : 'pointer',
              padding: '4px 8px',
              borderRadius: '6px',
            }}
          >
            ✕
          </button>
        </div>

        {/* Tab Navigation */}
        <div
          style={{
            display: 'flex',
            borderBottom: '1px solid #30363d',
            backgroundColor: '#111418',
            padding: '0 16px',
            gap: '8px',
          }}
        >
          {[
            { id: 'sound', label: '🎯 Sound Detection' },
            { id: 'events', label: '⏱️ Event Processing' },
            { id: 'activities', label: '🧠 Activity Intelligence' },
            { id: 'alerts', label: '🚨 Caregiver Alerts' },
          ].map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              style={{
                backgroundColor: 'transparent',
                border: 'none',
                borderBottom: activeTab === tab.id ? '2px solid #58a6ff' : '2px solid transparent',
                color: activeTab === tab.id ? '#ffffff' : '#8b949e',
                fontWeight: activeTab === tab.id ? 600 : 500,
                fontSize: '0.82rem',
                padding: '12px 14px',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Content Body */}
        <div style={{ padding: '24px', overflowY: 'auto', flex: 1 }}>
          {isLoading ? (
            <div
              style={{
                textAlign: 'center',
                padding: '40px 0',
                color: '#8b949e',
                fontSize: '0.9rem',
              }}
            >
              ⏳ Loading saved settings from SQLite...
            </div>
          ) : (
            <div>
              {/* Tab 1: Sound Detection */}
              {activeTab === 'sound' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <div>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '8px',
                      }}
                    >
                      <label
                        htmlFor="confidence-slider"
                        style={{ fontWeight: 600, fontSize: '0.92rem', color: '#e6edf3' }}
                      >
                        Minimum Confidence Threshold
                      </label>
                      <span
                        style={{
                          backgroundColor: '#0d2d6e',
                          color: '#58a6ff',
                          padding: '3px 10px',
                          borderRadius: '6px',
                          fontWeight: 700,
                          fontSize: '0.95rem',
                          border: '1px solid #1f6feb',
                        }}
                      >
                        {Math.round(settings.confidence_threshold * 100)}%
                      </span>
                    </div>

                    <input
                      id="confidence-slider"
                      type="range"
                      min="0.10"
                      max="0.95"
                      step="0.05"
                      value={settings.confidence_threshold}
                      onChange={(e) =>
                        setSettings({
                          ...settings,
                          confidence_threshold: parseFloat(e.target.value),
                        })
                      }
                      style={{
                        width: '100%',
                        cursor: 'pointer',
                        accentColor: '#58a6ff',
                      }}
                    />

                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        fontSize: '0.72rem',
                        color: '#8b949e',
                        marginTop: '4px',
                      }}
                    >
                      <span>10% (High Sensitivity)</span>
                      <span>Default (40%)</span>
                      <span>95% (High Precision)</span>
                    </div>

                    <div
                      style={{
                        backgroundColor: '#1c2128',
                        border: '1px solid #30363d',
                        borderRadius: '8px',
                        padding: '12px 14px',
                        marginTop: '14px',
                        fontSize: '0.8rem',
                        color: '#8b949e',
                        lineHeight: 1.5,
                      }}
                    >
                      💡 <strong style={{ color: '#e6edf3' }}>How this works:</strong> Sound
                      predictions from YAMNet and acoustic analysis with confidence scores below this
                      threshold are discarded. Higher thresholds prevent false positives from background
                      chatter and ambient hums, while lower thresholds capture softer, quiet sounds.
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 2: Event Processing */}
              {activeTab === 'events' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '22px' }}>
                  {/* Cooldown */}
                  <div>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '6px',
                      }}
                    >
                      <label
                        htmlFor="cooldown-input"
                        style={{ fontWeight: 600, fontSize: '0.92rem', color: '#e6edf3' }}
                      >
                        Duplicate Suppression Cooldown (seconds)
                      </label>
                      <span
                        style={{
                          backgroundColor: '#21262d',
                          border: '1px solid #30363d',
                          padding: '2px 8px',
                          borderRadius: '6px',
                          fontWeight: 700,
                          color: '#58a6ff',
                          fontSize: '0.88rem',
                        }}
                      >
                        {settings.duplicate_cooldown_sec}s
                      </span>
                    </div>

                    <div style={{ display: 'flex', gap: '14px', alignItems: 'center' }}>
                      <input
                        id="cooldown-input"
                        type="range"
                        min="1"
                        max="30"
                        step="1"
                        value={settings.duplicate_cooldown_sec}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            duplicate_cooldown_sec: parseFloat(e.target.value),
                          })
                        }
                        style={{ flex: 1, cursor: 'pointer', accentColor: '#58a6ff' }}
                      />
                      <input
                        type="number"
                        min="1"
                        max="60"
                        value={settings.duplicate_cooldown_sec}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value);
                          if (!isNaN(val)) {
                            setSettings({ ...settings, duplicate_cooldown_sec: val });
                          }
                        }}
                        style={{
                          width: '70px',
                          backgroundColor: '#21262d',
                          color: '#e6edf3',
                          border: '1px solid #30363d',
                          borderRadius: '6px',
                          padding: '6px 8px',
                          textAlign: 'center',
                          fontSize: '0.85rem',
                          fontWeight: 600,
                        }}
                      />
                    </div>

                    <div style={{ fontSize: '0.75rem', color: '#8b949e', marginTop: '6px' }}>
                      Suppresses repeated rapid events of the same sound in the same room (e.g., rapid
                      knocking or key jingling within a few seconds) to keep the caregiver event log
                      concise.
                    </div>
                  </div>

                  {/* Grouping Window */}
                  <div>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '6px',
                      }}
                    >
                      <label
                        htmlFor="grouping-input"
                        style={{ fontWeight: 600, fontSize: '0.92rem', color: '#e6edf3' }}
                      >
                        Continuous Sound Grouping Window (seconds)
                      </label>
                      <span
                        style={{
                          backgroundColor: '#21262d',
                          border: '1px solid #30363d',
                          padding: '2px 8px',
                          borderRadius: '6px',
                          fontWeight: 700,
                          color: '#58a6ff',
                          fontSize: '0.88rem',
                        }}
                      >
                        {settings.continuous_grouping_window_sec}s
                      </span>
                    </div>

                    <div style={{ display: 'flex', gap: '14px', alignItems: 'center' }}>
                      <input
                        id="grouping-input"
                        type="range"
                        min="2"
                        max="45"
                        step="1"
                        value={settings.continuous_grouping_window_sec}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            continuous_grouping_window_sec: parseFloat(e.target.value),
                          })
                        }
                        style={{ flex: 1, cursor: 'pointer', accentColor: '#58a6ff' }}
                      />
                      <input
                        type="number"
                        min="2"
                        max="60"
                        value={settings.continuous_grouping_window_sec}
                        onChange={(e) => {
                          const val = parseFloat(e.target.value);
                          if (!isNaN(val)) {
                            setSettings({ ...settings, continuous_grouping_window_sec: val });
                          }
                        }}
                        style={{
                          width: '70px',
                          backgroundColor: '#21262d',
                          color: '#e6edf3',
                          border: '1px solid #30363d',
                          borderRadius: '6px',
                          padding: '6px 8px',
                          textAlign: 'center',
                          fontSize: '0.85rem',
                          fontWeight: 600,
                        }}
                      />
                    </div>

                    <div style={{ fontSize: '0.75rem', color: '#8b949e', marginTop: '6px' }}>
                      Continuous sound classes (running water, footsteps, vacuum, frying) occurring
                      within this window are grouped into a single ongoing event with extended duration
                      rather than spamming individual records.
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 3: Activity Detection */}
              {activeTab === 'activities' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  <div>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '6px',
                      }}
                    >
                      <label
                        htmlFor="activity-window-input"
                        style={{ fontWeight: 600, fontSize: '0.92rem', color: '#e6edf3' }}
                      >
                        Activity Correlation Time Window (minutes)
                      </label>
                      <span
                        style={{
                          backgroundColor: '#0d2d6e',
                          color: '#58a6ff',
                          padding: '3px 10px',
                          borderRadius: '6px',
                          fontWeight: 700,
                          fontSize: '0.92rem',
                          border: '1px solid #1f6feb',
                        }}
                      >
                        {settings.activity_window_min} minutes
                      </span>
                    </div>

                    <div style={{ display: 'flex', gap: '14px', alignItems: 'center' }}>
                      <input
                        id="activity-window-input"
                        type="range"
                        min="5"
                        max="60"
                        step="5"
                        value={settings.activity_window_min}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            activity_window_min: parseInt(e.target.value, 10),
                          })
                        }
                        style={{ flex: 1, cursor: 'pointer', accentColor: '#58a6ff' }}
                      />
                      <input
                        type="number"
                        min="3"
                        max="120"
                        value={settings.activity_window_min}
                        onChange={(e) => {
                          const val = parseInt(e.target.value, 10);
                          if (!isNaN(val)) {
                            setSettings({ ...settings, activity_window_min: val });
                          }
                        }}
                        style={{
                          width: '70px',
                          backgroundColor: '#21262d',
                          color: '#e6edf3',
                          border: '1px solid #30363d',
                          borderRadius: '6px',
                          padding: '6px 8px',
                          textAlign: 'center',
                          fontSize: '0.85rem',
                          fontWeight: 600,
                        }}
                      />
                    </div>

                    <div
                      style={{
                        backgroundColor: '#1c2128',
                        border: '1px solid #30363d',
                        borderRadius: '8px',
                        padding: '14px',
                        marginTop: '16px',
                        fontSize: '0.8rem',
                        color: '#8b949e',
                        lineHeight: 1.5,
                      }}
                    >
                      🧠 <strong style={{ color: '#e6edf3' }}>Activity Intelligence Pattern Matching:</strong>
                      <br />
                      The Activity Engine examines sound events logged within this trailing window to
                      infer high-level dementia daily routines without human tagging:
                      <ul style={{ margin: '8px 0 0 0', paddingLeft: '18px' }}>
                        <li>
                          <strong>Kitchen Activity:</strong> Faucet + Dishes/Pots + Microwave + Frying
                        </li>
                        <li>
                          <strong>Bathroom Hygiene:</strong> Running water + Toilet flush + Shower
                        </li>
                        <li>
                          <strong>Movement & Transition:</strong> Doors + Keys + Footsteps
                        </li>
                        <li>
                          <strong>Media & Leisure:</strong> Television or Radio
                        </li>
                      </ul>
                    </div>
                  </div>
                </div>
              )}

              {/* Tab 4: Caregiver Alerts */}
              {activeTab === 'alerts' && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
                  {/* Alert Generation Toggles */}
                  <div
                    style={{
                      backgroundColor: '#1c2128',
                      border: '1px solid #30363d',
                      borderRadius: '8px',
                      padding: '14px 16px',
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '12px' }}>
                      ⚡ Alert Generation Triggers
                    </div>

                    {/* Critical Alert Toggle */}
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '8px 0',
                        borderBottom: '1px solid #30363d',
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '0.85rem', color: '#f85149' }}>
                          🚨 Critical Alerts (Smoke Alarms, Fire)
                        </div>
                        <div style={{ fontSize: '0.74rem', color: '#8b949e' }}>
                          Creates urgent caregiver alerts when fire alarms or smoke detectors sound.
                        </div>
                      </div>
                      <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={settings.alerts_critical_enabled}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              alerts_critical_enabled: e.target.checked,
                            })
                          }
                          style={{ width: '18px', height: '18px', accentColor: '#f85149' }}
                        />
                      </label>
                    </div>

                    {/* High Alert Toggle */}
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '10px 0 2px 0',
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '0.85rem', color: '#e3b341' }}>
                          ⚠️ High-Severity Alerts (Glass Breaking, Falls)
                        </div>
                        <div style={{ fontSize: '0.74rem', color: '#8b949e' }}>
                          Creates alerts for shattered glass, heavy impacts, or potential falls.
                        </div>
                      </div>
                      <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={settings.alerts_high_enabled}
                          onChange={(e) =>
                            setSettings({
                              ...settings,
                              alerts_high_enabled: e.target.checked,
                            })
                          }
                          style={{ width: '18px', height: '18px', accentColor: '#e3b341' }}
                        />
                      </label>
                    </div>
                  </div>

                  {/* Browser Notifications & Audible Chimes */}
                  <div
                    style={{
                      backgroundColor: '#1c2128',
                      border: '1px solid #30363d',
                      borderRadius: '8px',
                      padding: '14px 16px',
                    }}
                  >
                    <div style={{ fontWeight: 600, fontSize: '0.9rem', marginBottom: '12px' }}>
                      🔔 Notification & Chime Delivery
                    </div>

                    {/* Desktop Notifications */}
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '8px 0',
                        borderBottom: '1px solid #30363d',
                      }}
                    >
                      <div>
                        <div
                          style={{
                            fontWeight: 600,
                            fontSize: '0.85rem',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '8px',
                          }}
                        >
                          <span>🖥️ Browser Desktop Notifications</span>
                          {notificationPermission === 'granted' ? (
                            <span
                              style={{
                                fontSize: '0.7rem',
                                color: '#3fb950',
                                backgroundColor: '#0d4429',
                                padding: '1px 6px',
                                borderRadius: '4px',
                              }}
                            >
                              ✓ Granted
                            </span>
                          ) : (
                            <span
                              style={{
                                fontSize: '0.7rem',
                                color: '#e3b341',
                                backgroundColor: '#271d0a',
                                padding: '1px 6px',
                                borderRadius: '4px',
                              }}
                            >
                              Needs Permission
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: '0.74rem', color: '#8b949e' }}>
                          Delivers OS notifications even when browser tab is running in the background.
                        </div>
                      </div>
                      <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={settings.notifications_enabled}
                          onChange={(e) => {
                            const val = e.target.checked;
                            setSettings({ ...settings, notifications_enabled: val });
                            if (val && notificationPermission !== 'granted') {
                              handleRequestPermission();
                            }
                          }}
                          style={{ width: '18px', height: '18px', accentColor: '#2ea043' }}
                        />
                      </label>
                    </div>

                    {/* Audible Chime */}
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '10px 0',
                        borderBottom: '1px solid #30363d',
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>
                          🔊 Caregiver Melodic Alert Chime
                        </div>
                        <div style={{ fontSize: '0.74rem', color: '#8b949e' }}>
                          Plays a gentle harmonic chime through speakers for critical alerts.
                        </div>
                      </div>
                      <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={settings.chime_enabled}
                          onChange={(e) => {
                            unlockAudioContext();
                            setSettings({ ...settings, chime_enabled: e.target.checked });
                          }}
                          style={{ width: '18px', height: '18px', accentColor: '#2ea043' }}
                        />
                      </label>
                    </div>

                    {/* Chime Severity Threshold */}
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        padding: '10px 0 2px 0',
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 600, fontSize: '0.85rem' }}>
                          Minimum Chime Severity
                        </div>
                        <div style={{ fontSize: '0.74rem', color: '#8b949e' }}>
                          Select which alert levels will trigger the audible chime sound.
                        </div>
                      </div>
                      <select
                        value={settings.chime_severity}
                        onChange={(e) =>
                          setSettings({
                            ...settings,
                            chime_severity: e.target.value as 'Critical' | 'High',
                          })
                        }
                        style={{
                          backgroundColor: '#21262d',
                          color: '#e6edf3',
                          border: '1px solid #30363d',
                          borderRadius: '6px',
                          padding: '6px 10px',
                          fontSize: '0.8rem',
                          fontWeight: 500,
                        }}
                      >
                        <option value="Critical">Critical Only (Smoke/Fire)</option>
                        <option value="High">Critical + High (Glass/Impacts)</option>
                      </select>
                    </div>
                  </div>

                  {/* Test Action Buttons */}
                  <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                    <button
                      type="button"
                      onClick={handleTestChimeSound}
                      style={{
                        backgroundColor: '#21262d',
                        color: '#58a6ff',
                        border: '1px solid #30363d',
                        borderRadius: '6px',
                        padding: '7px 12px',
                        fontSize: '0.78rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      ▶ Preview Chime
                    </button>
                    <button
                      type="button"
                      onClick={handleTestBrowserNotification}
                      style={{
                        backgroundColor: '#21262d',
                        color: '#58a6ff',
                        border: '1px solid #30363d',
                        borderRadius: '6px',
                        padding: '7px 12px',
                        fontSize: '0.78rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      🔔 Test Desktop Notification
                    </button>
                    {testFeedback && (
                      <span style={{ fontSize: '0.78rem', color: '#3fb950', fontWeight: 500 }}>
                        {testFeedback}
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Feedback banners */}
          {errorMsg && (
            <div
              style={{
                marginTop: '16px',
                padding: '10px 14px',
                backgroundColor: '#4d0000',
                border: '1px solid #f85149',
                borderRadius: '6px',
                fontSize: '0.8rem',
                color: '#ffffff',
              }}
            >
              ⚠ {errorMsg}
            </div>
          )}

          {successMsg && (
            <div
              style={{
                marginTop: '16px',
                padding: '10px 14px',
                backgroundColor: '#0d4429',
                border: '1px solid #2ea043',
                borderRadius: '6px',
                fontSize: '0.8rem',
                color: '#ffffff',
              }}
            >
              {successMsg}
            </div>
          )}
        </div>

        {/* Footer Actions */}
        <div
          style={{
            padding: '16px 24px',
            borderTop: '1px solid #30363d',
            backgroundColor: '#1c2128',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <button
            type="button"
            onClick={handleResetDefaults}
            disabled={isSaving || isLoading}
            style={{
              backgroundColor: 'transparent',
              border: 'none',
              color: '#8b949e',
              fontSize: '0.82rem',
              cursor: isSaving || isLoading ? 'not-allowed' : 'pointer',
              textDecoration: 'underline',
              padding: '6px 0',
            }}
          >
            Reset to Defaults
          </button>

          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              type="button"
              onClick={() => onClose()}
              disabled={isSaving}
              style={{
                backgroundColor: '#21262d',
                color: '#c9d1d9',
                border: '1px solid #30363d',
                borderRadius: '6px',
                padding: '8px 16px',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: isSaving ? 'not-allowed' : 'pointer',
              }}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving || isLoading}
              style={{
                backgroundColor: isSaving ? '#195b28' : '#238636',
                color: '#ffffff',
                border: '1px solid #2ea043',
                borderRadius: '6px',
                padding: '8px 20px',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: isSaving || isLoading ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              {isSaving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
