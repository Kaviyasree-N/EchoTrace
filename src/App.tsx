import React, { useState, useEffect, useRef, useMemo } from 'react';
import { ROOMS, TARGET_CLASSES } from './config';
import type { SoundEvent, Activity, Alert, StatsData, AiStatus, NotificationPermissionState, AppSettings } from './types';
import SettingsModal from './components/SettingsModal';
import { playAlertChime, unlockAudioContext } from './utils/alertChime';
import {
  getNotificationPermissionStatus,
  requestNotificationPermission,
  sendCaregiverNotification,
} from './utils/notificationService';


function getOrCreateClientSessionId(): string {
  const SESSION_KEY = 'echotrace_client_session_id';
  try {
    if (typeof window !== 'undefined' && window.sessionStorage) {
      const stored = window.sessionStorage.getItem(SESSION_KEY);
      if (stored && typeof stored === 'string' && stored.trim().length > 0) {
        return stored.trim();
      }
      let newId: string;
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        newId = crypto.randomUUID();
      } else {
        newId = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          const v = c === 'x' ? r : (r & 0x3) | 0x8;
          return v.toString(16);
        });
      }
      window.sessionStorage.setItem(SESSION_KEY, newId);
      return newId;
    }
  } catch {
    // sessionStorage might be restricted in some iframe contexts
  }
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : 'session-' + Date.now().toString(36) + '-' + Math.random().toString(36).substring(2, 10);
}

export default function App() {
  // Client session identification (unique per independent tab session, persistent across reloads)
  const [clientSessionId] = useState<string>(() => getOrCreateClientSessionId());

  // Navigation & room state
  const [room, setRoom] = useState<string>('Living Room');
  const [isListening, setIsListening] = useState<boolean>(false);
  const [audioLevel, setAudioLevel] = useState<number>(0);
  const [micError, setMicError] = useState<string | null>(null);

  // AI Service & Model status
  const [aiStatus, setAiStatus] = useState<AiStatus>({
    ready: false,
    model: 'YAMNet',
    status: 'connecting',
  });

  // Data states from SQLite
  const [recentEvents, setRecentEvents] = useState<SoundEvent[]>([]);
  const [allEvents, setAllEvents] = useState<SoundEvent[]>([]);
  const [activities, setActivities] = useState<Activity[]>([]);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [unackAlertCount, setUnackAlertCount] = useState<number>(0);
  const [stats, setStats] = useState<StatsData>({
    total: 0,
    today: 0,
    thisWeek: 0,
    top_sounds: [],
    roomDistribution: [],
    timeOfDay: { morning: 0, afternoon: 0, evening: 0, night: 0 },
    alertsSummary: { total: 0, unacknowledged: 0, critical: 0, high: 0, medium: 0, low: 0 },
    activitiesCount: 0,
  });
  const [sessionCounts, setSessionCounts] = useState<Record<string, number>>({});

  // Search & Filter state
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchRoom, setSearchRoom] = useState<string>('All Rooms');
  const [searchSource, setSearchSource] = useState<string>('All');
  const [searchSession, setSearchSession] = useState<string>('All');
  const [searchResults, setSearchResults] = useState<SoundEvent[]>([]);
  const [allRooms, setAllRooms] = useState<string[]>([...ROOMS]);

  // Expanders & Modals
  const [privacyOpen, setPrivacyOpen] = useState<boolean>(false);
  const [monitoredOpen, setMonitoredOpen] = useState<boolean>(false);
  const [simulatorOpen, setSimulatorOpen] = useState<boolean>(true);
  const [fullLogOpen, setFullLogOpen] = useState<boolean>(false);
  const [resetModalOpen, setResetModalOpen] = useState<boolean>(false);
  const [clearModalOpen, setClearModalOpen] = useState<boolean>(false);
  const [onlyUnackAlerts, setOnlyUnackAlerts] = useState<boolean>(false);
  const [settingsModalOpen, setSettingsModalOpen] = useState<boolean>(false);
  const [activeTab, setActiveTab] = useState<'overview' | 'alerts' | 'activities' | 'history' | 'analytics'>('overview');
  const [infoModalOpen, setInfoModalOpen] = useState<'privacy' | 'monitored' | null>(null);

  // Caregiver Alert Notification & Chime settings
  const [notificationsEnabled, setNotificationsEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return localStorage.getItem('echotrace_notifications_enabled') !== 'false';
  });
  const [chimeEnabled, setChimeEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return localStorage.getItem('echotrace_chime_enabled') === 'true';
  });
  const [chimeSeverity, setChimeSeverity] = useState<'Critical' | 'High'>(() => {
    if (typeof window === 'undefined') return 'Critical';
    return (localStorage.getItem('echotrace_chime_severity') as 'Critical' | 'High') || 'Critical';
  });
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermissionState>(
    getNotificationPermissionStatus()
  );
  const [notificationSettingsOpen, setNotificationSettingsOpen] = useState<boolean>(false);
  const [testNotificationFeedback, setTestNotificationFeedback] = useState<string | null>(null);

  // Deduplication for alerts to ensure chime and notifications trigger only once per alert ID
  const notifiedAlertIdsRef = useRef<Set<number>>(new Set());
  const isInitialAlertsLoadedRef = useRef<boolean>(false);


  // Web Audio refs for real microphone capture via AudioWorklet
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioWorkletNodeRef = useRef<AudioWorkletNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const isClassifyingRef = useRef<boolean>(false);
  const roomRef = useRef<string>(room);

  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  // ── Data Fetching Functions ───────────────────────────────────────────────

  const checkAiStatus = async () => {
    try {
      const res = await fetch('/api/ai/status');
      if (res.ok) {
        const data = await res.json();
        setAiStatus(data);
      }
    } catch {
      setAiStatus({ ready: false, model: 'YAMNet', status: 'offline' });
    }
  };

  const refreshStats = async () => {
    try {
      const res = await fetch('/api/stats');
      if (res.ok) {
        const data = await res.json();
        setStats(data);
      }
    } catch {
      // transient network error ignored
    }
  };

  const refreshRooms = async () => {
    try {
      const res = await fetch('/api/rooms');
      if (res.ok) {
        const rooms = await res.json();
        setAllRooms(rooms);
      }
    } catch {
      // ignore
    }
  };

  const refreshRecentEvents = async () => {
    try {
      const res = await fetch('/api/events?limit=8');
      if (res.ok) {
        const data = await res.json();
        setRecentEvents(data);
      }
    } catch {
      // ignore
    }
  };

  const refreshAllEvents = async () => {
    try {
      const res = await fetch('/api/events?limit=100');
      if (res.ok) {
        const data = await res.json();
        setAllEvents(data);
      }
    } catch {
      // ignore
    }
  };

  const refreshActivities = async () => {
    try {
      const res = await fetch('/api/activities?limit=10');
      if (res.ok) {
        const data = await res.json();
        setActivities(data);
      }
    } catch {
      // ignore
    }
  };

  const refreshSettings = async () => {
    try {
      const res = await fetch('/api/settings');
      if (res.ok) {
        const data = await res.json();
        if (data.notifications_enabled !== undefined) {
          const val = data.notifications_enabled !== 'false';
          setNotificationsEnabled(val);
          localStorage.setItem('echotrace_notifications_enabled', String(val));
        }
        if (data.chime_enabled !== undefined) {
          const val = data.chime_enabled === 'true';
          setChimeEnabled(val);
          localStorage.setItem('echotrace_chime_enabled', String(val));
        }
        if (data.chime_severity !== undefined) {
          const val = (data.chime_severity as 'Critical' | 'High') || 'Critical';
          setChimeSeverity(val);
          localStorage.setItem('echotrace_chime_severity', val);
        }
      }
    } catch {
      // ignore
    }
  };

  const notifyNewAlert = (alert: Alert) => {
    if (!alert || alert.acknowledged === 1) return;
    if (notifiedAlertIdsRef.current.has(alert.id)) return;

    notifiedAlertIdsRef.current.add(alert.id);

    // 1. Audible chime (for critical, or critical+high if enabled)
    const qualifiesForChime =
      alert.severity === 'Critical' || (chimeSeverity === 'High' && alert.severity === 'High');

    if (chimeEnabled && qualifiesForChime) {
      playAlertChime();
    }

    // 2. Browser Desktop Notification (for critical and high severity)
    if (
      notificationsEnabled &&
      notificationPermission === 'granted' &&
      (alert.severity === 'Critical' || alert.severity === 'High')
    ) {
      sendCaregiverNotification(alert, (id) => {
        const el = document.getElementById(`alert-row-${id}`) || document.getElementById('alerts-section');
        if (el) {
          el.scrollIntoView({ behavior: 'smooth' });
        }
      });
    }
  };

  const refreshAlerts = async () => {
    try {
      const url = onlyUnackAlerts ? '/api/alerts?onlyUnacknowledged=true' : '/api/alerts';
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        const incomingAlerts: Alert[] = data.alerts || [];
        setAlerts(incomingAlerts);
        setUnackAlertCount(data.unacknowledgedCount || 0);

        // First load: seed notified set without chiming historical records
        if (!isInitialAlertsLoadedRef.current) {
          incomingAlerts.forEach((a) => notifiedAlertIdsRef.current.add(a.id));
          isInitialAlertsLoadedRef.current = true;
        } else {
          // Check for newly generated unacknowledged alerts
          incomingAlerts.forEach((a) => {
            if (a.acknowledged === 0 && !notifiedAlertIdsRef.current.has(a.id)) {
              notifyNewAlert(a);
            }
          });
        }
      }
    } catch {
      // ignore
    }
  };

  const handleRequestNotificationPermission = async () => {
    unlockAudioContext();
    const perm = await requestNotificationPermission();
    setNotificationPermission(perm);
    if (perm === 'granted') {
      setNotificationsEnabled(true);
      localStorage.setItem('echotrace_notifications_enabled', 'true');
      setTestNotificationFeedback('✓ Permission granted! Browser notifications are active.');
      setTimeout(() => setTestNotificationFeedback(null), 4000);
    } else if (perm === 'denied') {
      setTestNotificationFeedback('⚠ Notification permission was blocked in browser settings.');
      setTimeout(() => setTestNotificationFeedback(null), 6000);
    }
  };

  const handleToggleNotifications = () => {
    const next = !notificationsEnabled;
    setNotificationsEnabled(next);
    localStorage.setItem('echotrace_notifications_enabled', String(next));
    if (next && notificationPermission !== 'granted') {
      handleRequestNotificationPermission();
    }
  };

  const handleToggleChime = () => {
    unlockAudioContext();
    const next = !chimeEnabled;
    setChimeEnabled(next);
    localStorage.setItem('echotrace_chime_enabled', String(next));
    if (next) {
      playAlertChime();
    }
  };

  const handleTestChime = () => {
    unlockAudioContext();
    playAlertChime();
  };

  const handleTestNotification = () => {
    if (notificationPermission !== 'granted') {
      handleRequestNotificationPermission();
      return;
    }
    const sampleAlert: Alert = {
      id: Date.now(),
      event_id: null,
      alert_type: 'Smoke Detector Activated',
      severity: 'Critical',
      description: 'Caregiver notification test: verification of browser notifications and chime.',
      timestamp: new Date().toISOString(),
      acknowledged: 0,
      acknowledged_at: null,
      source: 'simulator',
      room: room,
    };
    sendCaregiverNotification(sampleAlert, () => {
      const el = document.getElementById('alerts-section');
      if (el) el.scrollIntoView({ behavior: 'smooth' });
    });
    if (chimeEnabled) {
      playAlertChime();
    }
    setTestNotificationFeedback('✓ Test notification dispatched to your desktop.');
    setTimeout(() => setTestNotificationFeedback(null), 4000);
  };

  const handleAcknowledgeAllAlerts = async () => {
    try {
      const res = await fetch('/api/alerts/ack-all', { method: 'POST' });
      if (res.ok) {
        refreshAlerts();
        refreshStats();
      }
    } catch (err) {
      console.error('Ack all alerts failed:', err);
    }
  };

  const handleSettingsSaved = (newSettings: AppSettings) => {
    setNotificationsEnabled(newSettings.notifications_enabled);
    setChimeEnabled(newSettings.chime_enabled);
    setChimeSeverity(newSettings.chime_severity);
    refreshStats();
    refreshRecentEvents();
    refreshActivities();
    refreshAlerts();
    if (fullLogOpen) refreshAllEvents();
  };


  // Initial load
  useEffect(() => {
    checkAiStatus();
    refreshSettings();
    refreshStats();
    refreshRooms();
    refreshRecentEvents();
    refreshActivities();
    refreshAlerts();
  }, [onlyUnackAlerts]);

  // Periodic AI health check
  useEffect(() => {
    const timer = setInterval(checkAiStatus, 6000);
    return () => clearInterval(timer);
  }, []);

  // Polling every 3s while listening (replicates st.fragment run_every=3)
  useEffect(() => {
    if (!isListening) return;

    const interval = setInterval(() => {
      refreshRecentEvents();
      refreshStats();
      refreshActivities();
      refreshAlerts();
      if (fullLogOpen) refreshAllEvents();
    }, 3000);

    return () => clearInterval(interval);
  }, [isListening, fullLogOpen]);

  // Search effect with debounce
  useEffect(() => {
    if (!searchQuery.trim() && searchRoom === 'All Rooms' && searchSource === 'All' && searchSession === 'All') {
      setSearchResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams();
        if (searchQuery.trim()) params.set('q', searchQuery.trim());
        if (searchRoom !== 'All Rooms') params.set('room', searchRoom);
        if (searchSource !== 'All') params.set('source', searchSource);
        if (searchSession !== 'All') params.set('session', searchSession);
        params.set('limit', '200');

        const res = await fetch(`/api/events?${params.toString()}`);
        if (res.ok) {
          const data = await res.json();
          setSearchResults(data);
        }
      } catch {
        // ignore
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [searchQuery, searchRoom, searchSource, searchSession]);

  // ── Real Microphone Web Audio Pipeline (AudioWorklet) ────────────────────

  const stopAudioCapture = () => {
    setIsListening(false);
    setAudioLevel(0);

    if (audioWorkletNodeRef.current) {
      try {
        audioWorkletNodeRef.current.port.postMessage({ command: 'stop' });
        audioWorkletNodeRef.current.disconnect();
      } catch {
        // ignore disconnect errors
      }
      audioWorkletNodeRef.current = null;
    }

    if (sourceNodeRef.current) {
      try {
        sourceNodeRef.current.disconnect();
      } catch {
        // ignore disconnect errors
      }
      sourceNodeRef.current = null;
    }

    if (mediaStreamRef.current) {
      try {
        mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      } catch {
        // ignore
      }
      mediaStreamRef.current = null;
    }

    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
  };

  const startAudioCapture = async () => {
    setMicError(null);
    unlockAudioContext();
    // Cleanup any existing active capture session to avoid duplicate streams
    stopAudioCapture();

    try {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('Microphone access is not supported by your browser or environment.');
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: { ideal: 1 },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      mediaStreamRef.current = stream;
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) {
        throw new Error('Web Audio API is not supported in this browser.');
      }

      const audioCtx = new AudioCtx();
      audioContextRef.current = audioCtx;

      if (audioCtx.state === 'suspended') {
        await audioCtx.resume();
      }

      if (!audioCtx.audioWorklet) {
        throw new Error('AudioWorklet is not supported in this browser context.');
      }

      // Load custom AudioWorkletProcessor module from /public
      await audioCtx.audioWorklet.addModule('/audio-recorder-worklet.js');

      // Create AudioWorkletNode running on dedicated audio thread
      const workletNode = new AudioWorkletNode(audioCtx, 'audio-recorder-worklet');
      audioWorkletNodeRef.current = workletNode;

      const source = audioCtx.createMediaStreamSource(stream);
      sourceNodeRef.current = source;

      // Pipe microphone into AudioWorkletProcessor
      source.connect(workletNode);

      // Connect to a silent gain node to destination to ensure audio graph remains active
      const muteGain = audioCtx.createGain();
      muteGain.gain.value = 0;
      workletNode.connect(muteGain);
      muteGain.connect(audioCtx.destination);

      workletNode.port.onmessage = async (event: MessageEvent) => {
        const data = event.data;
        if (!data) return;

        if (data.type === 'volume') {
          setAudioLevel(data.level ?? 0);
        } else if (data.type === 'chunk') {
          const chunkToSend: number[] = data.samples;
          if (!chunkToSend || chunkToSend.length === 0) return;

          // Check if chunk has meaningful energy to avoid classifying pure silence
          const rms = Math.sqrt(chunkToSend.reduce((acc, v) => acc + v * v, 0) / chunkToSend.length);
          if (rms > 0.012 && !isClassifyingRef.current) {
            isClassifyingRef.current = true;
            try {
              const res = await fetch('/api/ai/classify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  samples: chunkToSend,
                  sample_rate: data.sampleRate || 16000,
                  room: roomRef.current,
                  source: 'microphone',
                  clientSessionId,
                  client_session_id: clientSessionId,
                  session_id: clientSessionId,
                }),
              });

              if (res.ok) {
                const result = await res.json();
                if (result.detected && result.eventResult?.event && result.eventResult.status !== 'suppressed') {
                  const ev = result.eventResult.event;
                  setRecentEvents((prev) => [ev, ...prev.filter((p) => p.id !== ev.id).slice(0, 7)]);
                  setSessionCounts((prev) => ({
                    ...prev,
                    [ev.sound_class]: (prev[ev.sound_class] || 0) + 1,
                  }));
                  if (result.eventResult?.alert) {
                    notifyNewAlert(result.eventResult.alert);
                  }
                  refreshStats();
                  refreshActivities();
                  refreshAlerts();
                }
              }
            } catch (err) {
              console.warn('AudioWorklet inference request failed:', err);
            } finally {
              isClassifyingRef.current = false;
            }
          }
        }
      };

      // Start capture in the AudioWorklet
      workletNode.port.postMessage({ command: 'start' });
      setIsListening(true);
    } catch (err: any) {
      console.warn('Microphone AudioWorklet error:', err);
      let errorDesc = err.message || 'Unknown error';
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        errorDesc = 'Microphone permission was denied. Please allow microphone access in your browser site permissions to monitor live sound.';
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        errorDesc = 'No microphone input device was detected on your computer.';
      } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
        errorDesc = 'Microphone is currently in use or blocked by another application or browser tab.';
      }
      setMicError(`Microphone unavailable: ${errorDesc} You can test detections anytime using the Quick Sound Simulator in the sidebar.`);
      stopAudioCapture();
    }
  };

  // Ensure clean teardown on component unmount
  useEffect(() => {
    return () => {
      stopAudioCapture();
    };
  }, []);


  // ── Simulator Sound Trigger ───────────────────────────────────────────────

  const triggerSimulatedSound = async (soundClass: string, confidence: number = 0.88) => {
    try {
      const payload = {
        sound_class: soundClass,
        confidence,
        room,
        duration: 1.5,
        source: 'simulator',
        timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        clientSessionId,
        client_session_id: clientSessionId,
        session_id: clientSessionId,
      };

      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const result = await res.json();
        if (result.status === 'suppressed') {
          // Suppressed by duplicate cooldown - do not duplicate in UI
        } else if (result.event) {
          const ev = result.event;
          setRecentEvents((prev) => [ev, ...prev.filter((p) => p.id !== ev.id).slice(0, 7)]);
          setSessionCounts((prev) => ({
            ...prev,
            [ev.sound_class]: (prev[ev.sound_class] || 0) + 1,
          }));
          if (result.alert) {
            notifyNewAlert(result.alert);
          }
          refreshStats();
          refreshActivities();
          refreshAlerts();
          refreshRooms();
          if (fullLogOpen) refreshAllEvents();
        }
      }
    } catch (err) {
      console.error('Simulator trigger failed:', err);
    }
  };

  // Acknowledge Alert Handler
  const handleAcknowledgeAlert = async (alertId: number) => {
    try {
      const res = await fetch(`/api/alerts/${alertId}/ack`, { method: 'POST' });
      if (res.ok) {
        refreshAlerts();
        refreshStats();
      }
    } catch (err) {
      console.error('Ack alert failed:', err);
    }
  };

  // Reset Sample Data
  const handleResetSampleData = async () => {
    try {
      const res = await fetch('/api/reset', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      if (res.ok) {
        setResetModalOpen(false);
        refreshStats();
        refreshRecentEvents();
        refreshAllEvents();
        refreshActivities();
        refreshAlerts();
        setSessionCounts({});
      }
    } catch (err) {
      console.error('Reset failed:', err);
    }
  };

  // Clear All Events
  const handleClearHistory = async () => {
    try {
      const res = await fetch('/api/events', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      });
      if (res.ok) {
        setClearModalOpen(false);
        refreshStats();
        refreshRecentEvents();
        refreshAllEvents();
        refreshActivities();
        refreshAlerts();
        setSessionCounts({});
      }
    } catch (err) {
      console.error('Clear failed:', err);
    }
  };

  // Format Helpers
  const formatTime = (ts: string) => {
    try {
      return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {
      return ts;
    }
  };

  const formatDateTime = (ts: string) => {
    try {
      return new Date(ts).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' });
    } catch {
      return ts;
    }
  };

  // Bar Chart Data
  const barChartData = useMemo(() => {
    if (Object.keys(sessionCounts).length > 0) {
      return Object.entries(sessionCounts)
        .map(([sound, count]) => ({ sound, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 8);
    }
    if (stats.top_sounds && stats.top_sounds.length > 0) {
      return stats.top_sounds.map((s) => ({ sound: s.sound_class, count: s.n }));
    }
    return [];
  }, [sessionCounts, stats.top_sounds]);

  const maxBarCount = useMemo(() => {
    if (barChartData.length === 0) return 1;
    return Math.max(...barChartData.map((d) => d.count), 1);
  }, [barChartData]);

  // Unacknowledged critical or high alert for top banner
  const topActiveAlert = useMemo(() => {
    return alerts.find((a) => a.acknowledged === 0 && (a.severity === 'Critical' || a.severity === 'High'));
  }, [alerts]);

  return (
    <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#0d1117', color: '#e6edf3', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' }}>
      {/* ── SIDEBAR NAVIGATION ─────────────────────────────────────────────── */}
      <aside
        style={{
          width: '260px',
          minWidth: '260px',
          backgroundColor: '#161b22',
          borderRight: '1px solid #30363d',
          padding: '20px 16px',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
          userSelect: 'none',
        }}
      >
        {/* Brand */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
            <span style={{ fontSize: '1.4rem' }}>🎧</span>
            <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 700, color: '#ffffff', letterSpacing: '-0.02em' }}>
              EchoTrace
            </h2>
          </div>
          <div style={{ fontSize: '0.76rem', color: '#8b949e', lineHeight: 1.3 }}>
            Ambient Sound Memory · Caregiver Assistant
          </div>
        </div>

        <hr style={{ border: 'none', borderTop: '1px solid #30363d', margin: '2px 0' }} />

        {/* Room selector */}
        <div>
          <label style={{ display: 'block', fontSize: '0.74rem', color: '#8b949e', marginBottom: '6px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            📍 Monitored Room
          </label>
          <select
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            style={{
              width: '100%',
              backgroundColor: '#21262d',
              color: '#e6edf3',
              border: '1px solid #30363d',
              borderRadius: '6px',
              padding: '8px 10px',
              fontSize: '0.85rem',
              fontWeight: 500,
              outline: 'none',
              cursor: 'pointer',
            }}
          >
            {ROOMS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>

        {/* Navigation Tabs Menu */}
        <div>
          <div style={{ fontSize: '0.74rem', color: '#8b949e', marginBottom: '6px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Navigation
          </div>
          <nav style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {[
              { id: 'overview', label: 'Live Overview', icon: '🔴', count: null },
              { id: 'alerts', label: 'Caregiver Alerts', icon: '🚨', count: unackAlertCount > 0 ? unackAlertCount : null, alert: unackAlertCount > 0 },
              { id: 'activities', label: 'Daily Routines', icon: '🧠', count: activities.length },
              { id: 'history', label: 'Search & Timeline', icon: '🔍', count: null },
              { id: 'analytics', label: 'Insights & Patterns', icon: '📊', count: null },
            ].map((item) => {
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id as typeof activeTab)}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    width: '100%',
                    padding: '8px 10px',
                    borderRadius: '6px',
                    border: active ? '1px solid #1f6feb' : '1px solid transparent',
                    backgroundColor: active ? 'rgba(31, 111, 235, 0.15)' : 'transparent',
                    color: active ? '#58a6ff' : '#c9d1d9',
                    fontSize: '0.82rem',
                    fontWeight: active ? 600 : 500,
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 0.15s ease',
                  }}
                >
                  <span style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    <span>{item.icon}</span>
                    <span>{item.label}</span>
                  </span>
                  {item.count !== null && (
                    <span
                      style={{
                        fontSize: '0.7rem',
                        fontWeight: 700,
                        padding: '1px 6px',
                        borderRadius: '999px',
                        backgroundColor: item.alert ? '#da3633' : '#21262d',
                        color: item.alert ? '#ffffff' : '#8b949e',
                      }}
                    >
                      {item.count}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* System & Session Status */}
        <div style={{ backgroundColor: '#0d1117', border: '1px solid #30363d', borderRadius: '8px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '0.74rem' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#8b949e' }}>AI Model:</span>
            <span
              style={{
                color: aiStatus.ready && aiStatus.is_neural_network ? '#3fb950' : '#e3b341',
                fontWeight: 600,
              }}
            >
              {aiStatus.ready && aiStatus.is_neural_network ? '✓ YAMNet Ready' : aiStatus.status === 'loading' ? '⏳ Loading…' : '⚠️ Ready'}
            </span>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#8b949e' }}>Session:</span>
            <span
              title={`Active Tab Session: ${clientSessionId}`}
              style={{
                fontFamily: 'monospace',
                color: '#58a6ff',
                backgroundColor: '#161b22',
                padding: '1px 5px',
                borderRadius: '4px',
                border: '1px solid #30363d',
              }}
            >
              {clientSessionId.slice(0, 8)}…
            </span>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#8b949e' }}>Microphone:</span>
            <span style={{ color: isListening ? '#3fb950' : '#8b949e', fontWeight: 600 }}>
              {isListening ? `● Live (${audioLevel}%)` : '○ Standby'}
            </span>
          </div>
        </div>

        {/* Bottom Navigation & Tools */}
        <div style={{ marginTop: 'auto', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <button
            onClick={() => setSettingsModalOpen(true)}
            style={{
              width: '100%',
              backgroundColor: '#21262d',
              color: '#e6edf3',
              border: '1px solid #30363d',
              borderRadius: '6px',
              padding: '7px 10px',
              fontSize: '0.78rem',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
            }}
          >
            ⚙️ Settings & Thresholds
          </button>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
            <button
              onClick={() => setInfoModalOpen('privacy')}
              style={{
                backgroundColor: '#161b22',
                color: '#8b949e',
                border: '1px solid #30363d',
                borderRadius: '6px',
                padding: '5px 6px',
                fontSize: '0.72rem',
                cursor: 'pointer',
                textAlign: 'center',
              }}
            >
              🔒 Privacy
            </button>
            <button
              onClick={() => setInfoModalOpen('monitored')}
              style={{
                backgroundColor: '#161b22',
                color: '#8b949e',
                border: '1px solid #30363d',
                borderRadius: '6px',
                padding: '5px 6px',
                fontSize: '0.72rem',
                cursor: 'pointer',
                textAlign: 'center',
              }}
            >
              📋 Classes (20)
            </button>
          </div>

          <a
            href="/api/reports/csv"
            download
            style={{
              width: '100%',
              backgroundColor: '#161b22',
              color: '#58a6ff',
              border: '1px solid #30363d',
              borderRadius: '6px',
              padding: '6px 10px',
              fontSize: '0.74rem',
              fontWeight: 500,
              textDecoration: 'none',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              boxSizing: 'border-box',
            }}
          >
            📥 Export CSV Report
          </a>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
            <button
              onClick={() => setResetModalOpen(true)}
              style={{
                backgroundColor: '#161b22',
                color: '#8b949e',
                border: '1px solid #30363d',
                borderRadius: '6px',
                padding: '5px 4px',
                fontSize: '0.7rem',
                cursor: 'pointer',
                textAlign: 'center',
              }}
            >
              🔄 Reset Demo
            </button>
            <button
              onClick={() => setClearModalOpen(true)}
              style={{
                backgroundColor: '#161b22',
                color: '#f85149',
                border: '1px solid #30363d',
                borderRadius: '6px',
                padding: '5px 4px',
                fontSize: '0.7rem',
                cursor: 'pointer',
                textAlign: 'center',
              }}
            >
              🗑️ Clear DB
            </button>
          </div>
        </div>
      </aside>

      {/* ── MAIN CONTENT AREA ──────────────────────────────────────────────── */}
      <main style={{ flex: 1, padding: '24px 32px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '20px' }}>
        {/* Top Active Urgent Alert Banner */}
        {topActiveAlert && (
          <div
            style={{
              backgroundColor: 'rgba(218, 54, 51, 0.15)',
              border: '1px solid #f85149',
              borderRadius: '8px',
              padding: '12px 18px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              boxShadow: '0 4px 16px rgba(248,81,73,0.18)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <span style={{ fontSize: '1.4rem' }}>🚨</span>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                  <strong style={{ color: '#ffffff', fontSize: '0.95rem' }}>
                    {topActiveAlert.alert_type} ({topActiveAlert.severity} Alert)
                  </strong>
                  <span
                    style={{
                      fontSize: '0.68rem',
                      padding: '1px 6px',
                      borderRadius: '4px',
                      backgroundColor: topActiveAlert.source === 'microphone' ? '#0d4429' : '#271d0a',
                      color: topActiveAlert.source === 'microphone' ? '#3fb950' : '#e3b341',
                      border: '1px solid currentColor',
                    }}
                  >
                    {topActiveAlert.source === 'microphone' ? '🎙️ Real Mic' : '⚡ Simulated'}
                  </span>
                </div>
                <div style={{ color: '#ffb3ba', fontSize: '0.8rem', marginTop: '2px' }}>
                  {topActiveAlert.description} &nbsp;·&nbsp; {topActiveAlert.room ? `📍 ${topActiveAlert.room}` : ''} &nbsp;·&nbsp; {formatDateTime(topActiveAlert.timestamp)}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <button
                onClick={() => setActiveTab('alerts')}
                style={{
                  backgroundColor: '#21262d',
                  color: '#e6edf3',
                  border: '1px solid #30363d',
                  borderRadius: '6px',
                  padding: '6px 12px',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                View Details
              </button>
              <button
                onClick={() => handleAcknowledgeAlert(topActiveAlert.id)}
                style={{
                  backgroundColor: '#f85149',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '6px 14px',
                  fontSize: '0.8rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                ✓ Acknowledge
              </button>
            </div>
          </div>
        )}

        {/* View Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '12px' }}>
          <div>
            <h1 style={{ margin: '0 0 4px 0', fontSize: '1.5rem', fontWeight: 700, color: '#ffffff' }}>
              {activeTab === 'overview' && 'Ambient Sound Monitor'}
              {activeTab === 'alerts' && 'Caregiver Alerts & Urgent Sounds'}
              {activeTab === 'activities' && 'Interpreted Daily Routines'}
              {activeTab === 'history' && 'Sound Timeline & Search'}
              {activeTab === 'analytics' && 'Activity Insights & Patterns'}
            </h1>
            <div style={{ fontSize: '0.84rem', color: '#8b949e' }}>
              {activeTab === 'overview' && `Real-time ambient sound classification and caregiver monitoring for ${room}`}
              {activeTab === 'alerts' && 'Manage urgent sound events requiring caregiver attention (smoke alarms, falls, broken glass)'}
              {activeTab === 'activities' && 'Composite routines synthesized from sequences of domestic sounds'}
              {activeTab === 'history' && 'Filter and search through the SQLite sound event database'}
              {activeTab === 'analytics' && 'Time-of-day activity trends and room sound distribution'}
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                padding: '5px 12px',
                borderRadius: '999px',
                fontSize: '0.78rem',
                fontWeight: 600,
                backgroundColor: isListening ? '#0d4429' : '#21262d',
                color: isListening ? '#3fb950' : '#8b949e',
                border: isListening ? '1px solid #238636' : '1px solid #30363d',
              }}
            >
              {isListening ? `● LIVE MONITORING (${audioLevel}%)` : '○ MONITORING STANDBY'}
            </span>

            <button
              onClick={() => setSettingsModalOpen(true)}
              style={{
                backgroundColor: '#21262d',
                color: '#e6edf3',
                border: '1px solid #30363d',
                borderRadius: '6px',
                padding: '6px 12px',
                fontSize: '0.8rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              ⚙️ Settings
            </button>
          </div>
        </div>

        {/* ── UNIFIED MONITORING & SOUND SIMULATOR CONSOLE ───────────────────── */}
        <div
          style={{
            backgroundColor: '#161b22',
            border: '1px solid #30363d',
            borderRadius: '10px',
            padding: '18px 20px',
            display: 'grid',
            gridTemplateColumns: '1.2fr 1.8fr',
            gap: '24px',
            boxShadow: '0 2px 10px rgba(0,0,0,0.15)',
          }}
        >
          {/* Column 1: Live Audio Controls & Visualizer */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                <span style={{ fontWeight: 600, fontSize: '0.9rem', color: '#e6edf3' }}>
                  🎙️ Ambient Microphone ({room})
                </span>
                <span style={{ fontSize: '0.75rem', color: isListening ? '#3fb950' : '#8b949e', fontWeight: 600 }}>
                  {isListening ? 'Active' : 'Stopped'}
                </span>
              </div>
              <div style={{ fontSize: '0.75rem', color: '#8b949e' }}>
                Captures ambient audio through AudioWorklet and classifies at 16 kHz locally.
              </div>
            </div>

            {/* Action button */}
            {isListening ? (
              <button
                onClick={stopAudioCapture}
                style={{
                  width: '100%',
                  backgroundColor: '#21262d',
                  color: '#f85149',
                  border: '1px solid #da3633',
                  borderRadius: '8px',
                  fontWeight: 600,
                  padding: '11px 16px',
                  fontSize: '0.9rem',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                }}
              >
                <span>⏹</span> Stop Listening
              </button>
            ) : (
              <button
                onClick={startAudioCapture}
                style={{
                  width: '100%',
                  backgroundColor: '#238636',
                  color: '#ffffff',
                  border: '1px solid #2ea043',
                  borderRadius: '8px',
                  fontWeight: 600,
                  padding: '11px 16px',
                  fontSize: '0.9rem',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: '8px',
                  boxShadow: '0 2px 8px rgba(35, 134, 54, 0.3)',
                }}
              >
                <span>▶</span> Start Listening
              </button>
            )}

            {/* Live Audio Volume Equalizer Meter */}
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.72rem', color: '#8b949e', marginBottom: '4px' }}>
                <span>Signal Activity</span>
                <span>{isListening ? `${audioLevel}%` : 'Off'}</span>
              </div>
              <div
                style={{
                  height: '10px',
                  backgroundColor: '#0d1117',
                  borderRadius: '5px',
                  overflow: 'hidden',
                  border: '1px solid #30363d',
                  display: 'flex',
                  padding: '1px',
                  gap: '2px',
                }}
              >
                {[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((step) => {
                  const active = isListening && audioLevel >= step;
                  const color = step <= 50 ? '#3fb950' : step <= 80 ? '#e3b341' : '#f85149';
                  return (
                    <div
                      key={step}
                      style={{
                        flex: 1,
                        backgroundColor: active ? color : '#21262d',
                        borderRadius: '2px',
                        transition: 'background-color 0.1s ease',
                      }}
                    />
                  );
                })}
              </div>
            </div>

            {micError && (
              <div
                style={{
                  padding: '6px 10px',
                  backgroundColor: '#271d0a',
                  border: '1px solid #9e6a03',
                  borderRadius: '6px',
                  fontSize: '0.74rem',
                  color: '#e3b341',
                }}
              >
                ⚠ {micError}
              </div>
            )}

            <div style={{ fontSize: '0.7rem', color: '#8b949e', display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span>🔒</span>
              <span>100% on-device privacy. Zero raw audio leaves this machine.</span>
            </div>
          </div>

          {/* Column 2: Quick Sound Simulator */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={{ fontWeight: 600, fontSize: '0.9rem', color: '#e6edf3' }}>
                ⚡ Quick Sound Simulator
              </div>
              <span style={{ fontSize: '0.72rem', color: '#e3b341', backgroundColor: '#271d0a', padding: '2px 8px', borderRadius: '4px', border: '1px solid #9e6a03' }}>
                Tagged as ⚡ Simulated
              </span>
            </div>
            <div style={{ fontSize: '0.75rem', color: '#8b949e' }}>
              Click any sound below to simulate an event in <strong>{room}</strong> and test caregiver alerts instantly:
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '6px' }}>
              {[
                { label: '🔑 Keys jingling', conf: 0.94 },
                { label: '🚪 Door knock', sound: 'Knock', conf: 0.88 },
                { label: '💧 Water tap', sound: 'Water tap, faucet', conf: 0.91 },
                { label: '🗣️ Speech', conf: 0.86 },
                { label: '👣 Footsteps', conf: 0.79 },
                { label: '☕ Coffee maker', conf: 0.92 },
                { label: '🍽️ Dishes & pans', sound: 'Dishes, pots, and pans', conf: 0.89 },
                { label: '🗄️ Drawer', conf: 0.84 },
                { label: '🪟 Glass breaking', sound: 'Glass breaking', conf: 0.96, isAlert: true, alertTag: 'High Alert' },
                { label: '🚨 Smoke alarm', sound: 'Smoke detector, smoke alarm', conf: 0.98, isAlert: true, alertTag: 'Critical' },
              ].map((item) => {
                return (
                  <button
                    key={item.label}
                    onClick={() => triggerSimulatedSound(item.sound || item.label.replace(/^[\p{Emoji}\s]+/u, ''), item.conf)}
                    style={{
                      backgroundColor: item.isAlert ? '#211215' : '#21262d',
                      color: item.isAlert ? '#ff7b72' : '#c9d1d9',
                      border: item.isAlert ? '1px solid #da3633' : '1px solid #30363d',
                      borderRadius: '6px',
                      padding: '7px 10px',
                      fontSize: '0.75rem',
                      fontWeight: 500,
                      textAlign: 'left',
                      cursor: 'pointer',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      transition: 'background-color 0.15s ease',
                    }}
                  >
                    <span>{item.label}</span>
                    {item.alertTag ? (
                      <span
                        style={{
                          fontSize: '0.65rem',
                          backgroundColor: '#f85149',
                          color: '#ffffff',
                          padding: '1px 5px',
                          borderRadius: '3px',
                          fontWeight: 700,
                        }}
                      >
                        {item.alertTag}
                      </span>
                    ) : (
                      <span style={{ fontSize: '0.68rem', color: '#8b949e' }}>{Math.round(item.conf * 100)}%</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* ── KEY METRICS ROW ──────────────────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '14px' }}>
          <div style={{ backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px', padding: '14px 16px' }}>
            <div style={{ color: '#8b949e', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '2px' }}>
              🔔 Today's Sounds
            </div>
            <div style={{ color: '#ffffff', fontSize: '1.6rem', fontWeight: 700 }}>{stats.today}</div>
            <div style={{ color: '#8b949e', fontSize: '0.72rem', marginTop: '2px' }}>
              {stats.total} total recorded events
            </div>
          </div>

          <div
            onClick={() => unackAlertCount > 0 && setActiveTab('alerts')}
            style={{
              backgroundColor: '#161b22',
              border: unackAlertCount > 0 ? '1px solid #f85149' : '1px solid #30363d',
              borderRadius: '8px',
              padding: '14px 16px',
              cursor: unackAlertCount > 0 ? 'pointer' : 'default',
            }}
          >
            <div style={{ color: '#8b949e', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '2px' }}>
              🚨 Active Caregiver Alerts
            </div>
            <div style={{ color: unackAlertCount > 0 ? '#f85149' : '#3fb950', fontSize: '1.6rem', fontWeight: 700 }}>
              {unackAlertCount}
            </div>
            <div style={{ color: unackAlertCount > 0 ? '#f85149' : '#3fb950', fontSize: '0.72rem', marginTop: '2px' }}>
              {unackAlertCount > 0 ? '● Pending review (Click to view)' : '✓ All quiet and safe'}
            </div>
          </div>

          <div
            onClick={() => setActiveTab('activities')}
            style={{ backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px', padding: '14px 16px', cursor: 'pointer' }}
          >
            <div style={{ color: '#8b949e', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '2px' }}>
              🧠 Daily Routines
            </div>
            <div style={{ color: '#ffffff', fontSize: '1.6rem', fontWeight: 700 }}>{activities.length}</div>
            <div style={{ color: '#58a6ff', fontSize: '0.72rem', marginTop: '2px' }}>
              Inferred activity patterns →
            </div>
          </div>

          <div style={{ backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px', padding: '14px 16px' }}>
            <div style={{ color: '#8b949e', fontSize: '0.72rem', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: '2px' }}>
              📍 Monitored Location
            </div>
            <div style={{ color: '#ffffff', fontSize: '1.3rem', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {room}
            </div>
            <div style={{ color: isListening ? '#3fb950' : '#8b949e', fontSize: '0.72rem', marginTop: '4px' }}>
              {isListening ? '● Live Audio Stream' : '○ Standby'}
            </div>
          </div>
        </div>

        {/* ── TAB 1: LIVE OVERVIEW ─────────────────────────────────────────── */}
        {activeTab === 'overview' && (
          <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: '20px' }}>
            {/* Column 1: Live Feed */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <h3 style={{ fontSize: '0.98rem', fontWeight: 600, color: '#e6edf3', margin: 0 }}>
                  🔴 Live Sound Feed
                </h3>
                <span style={{ fontSize: '0.72rem', color: '#8b949e' }}>Auto-refreshes every 3s</span>
              </div>

              {recentEvents.length > 0 ? (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {recentEvents.map((ev) => (
                    <div
                      key={ev.id}
                      style={{
                        backgroundColor: '#161b22',
                        border: '1px solid #30363d',
                        borderLeft: ev.source === 'microphone' ? '3px solid #3fb950' : '3px solid #58a6ff',
                        borderRadius: '6px',
                        padding: '10px 14px',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                          <span style={{ fontSize: '0.95rem', fontWeight: 600, color: '#ffffff' }}>
                            🔊 {ev.sound_class}
                          </span>
                          <span
                            style={{
                              fontSize: '0.68rem',
                              padding: '1px 5px',
                              borderRadius: '4px',
                              backgroundColor: ev.source === 'microphone' ? '#0d4429' : '#21262d',
                              color: ev.source === 'microphone' ? '#3fb950' : '#8b949e',
                              border: '1px solid #30363d',
                            }}
                          >
                            {ev.source === 'microphone' ? '🎙️ Mic' : '⚡ Sim'}
                          </span>
                          {ev.duration > 1 && (
                            <span style={{ fontSize: '0.7rem', color: '#8b949e' }}>
                              ⏱️ {ev.duration}s
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: '0.82rem', fontWeight: 600, color: '#58a6ff' }}>
                          {Math.round(ev.confidence * 100)}%
                        </div>
                      </div>
                      <div style={{ fontSize: '0.75rem', color: '#8b949e', marginTop: '3px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span>🕐 {formatTime(ev.timestamp)} &nbsp;|&nbsp; 📍 {ev.room}</span>
                        {(ev.client_session_id || ev.session_id) && (
                          <span style={{ fontSize: '0.68rem', color: '#8b949e', fontFamily: 'monospace' }}>
                            🆔 {(ev.client_session_id || ev.session_id || '').slice(0, 8)}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div
                  style={{
                    backgroundColor: '#161b22',
                    border: '1px dashed #30363d',
                    borderRadius: '8px',
                    padding: '24px 20px',
                    color: '#8b949e',
                    fontSize: '0.85rem',
                    textAlign: 'center',
                    lineHeight: 1.5,
                  }}
                >
                  {isListening
                    ? '👂 Listening for sounds in real time… Speak, clap, or click any sound in the Quick Sound Simulator above!'
                    : 'No sound events yet. Click ▶ Start Listening or test any sound in the Quick Sound Simulator.'}
                </div>
              )}
            </div>

            {/* Column 2: Sound Frequencies & Routine Highlights */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              {/* Sound Frequency */}
              <div style={{ backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px', padding: '14px 16px' }}>
                <h4 style={{ margin: '0 0 10px 0', fontSize: '0.88rem', fontWeight: 600, color: '#e6edf3' }}>
                  📊 Sound Frequency
                </h4>
                {barChartData.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {barChartData.slice(0, 6).map((item) => {
                      const pct = Math.max(10, Math.round((item.count / maxBarCount) * 100));
                      return (
                        <div key={item.sound}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.76rem', marginBottom: '2px' }}>
                            <span style={{ color: '#e6edf3' }}>{item.sound}</span>
                            <span style={{ color: '#58a6ff', fontWeight: 600 }}>{item.count}</span>
                          </div>
                          <div style={{ height: '8px', backgroundColor: '#21262d', borderRadius: '3px', overflow: 'hidden' }}>
                            <div style={{ width: `${pct}%`, height: '100%', backgroundColor: '#58a6ff', borderRadius: '3px' }} />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ) : (
                  <div style={{ fontSize: '0.78rem', color: '#8b949e' }}>
                    Sound frequencies will appear here as events are detected.
                  </div>
                )}
              </div>

              {/* Routine Highlights Card */}
              <div style={{ backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px', padding: '14px 16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                  <h4 style={{ margin: 0, fontSize: '0.88rem', fontWeight: 600, color: '#e6edf3' }}>
                    🧠 Daily Activity Routines
                  </h4>
                  <button
                    onClick={() => setActiveTab('activities')}
                    style={{ background: 'none', border: 'none', color: '#58a6ff', fontSize: '0.74rem', cursor: 'pointer', padding: 0 }}
                  >
                    View All ({activities.length}) →
                  </button>
                </div>
                {activities.length > 0 ? (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                    {activities.slice(0, 2).map((act) => (
                      <div key={act.id} style={{ backgroundColor: '#21262d', padding: '8px 10px', borderRadius: '6px', fontSize: '0.78rem' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', color: '#ffffff', fontWeight: 600 }}>
                          <span>{act.activity_type}</span>
                          <span style={{ color: '#58a6ff', fontSize: '0.72rem' }}>📍 {act.room}</span>
                        </div>
                        <div style={{ color: '#8b949e', fontSize: '0.72rem', marginTop: '2px' }}>
                          {act.description}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div style={{ fontSize: '0.78rem', color: '#8b949e' }}>
                    Activity sequences (e.g. hygiene, meal prep) will automatically form here.
                  </div>
                )}
              </div>

              {/* Caregiver Protection Settings Quick Card */}
              <div style={{ backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px', padding: '14px 16px' }}>
                <h4 style={{ margin: '0 0 6px 0', fontSize: '0.88rem', fontWeight: 600, color: '#e6edf3' }}>
                  🛡️ Caregiver Protection
                </h4>
                <div style={{ fontSize: '0.75rem', color: '#8b949e', lineHeight: 1.4, marginBottom: '8px' }}>
                  Alerts automatically sound a 2-tone melodic chime and dispatch desktop notifications.
                </div>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <button
                    onClick={handleTestChime}
                    style={{
                      backgroundColor: '#21262d',
                      color: '#58a6ff',
                      border: '1px solid #30363d',
                      borderRadius: '6px',
                      padding: '5px 10px',
                      fontSize: '0.74rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    ▶ Test Chime
                  </button>
                  <button
                    onClick={() => setActiveTab('alerts')}
                    style={{
                      backgroundColor: '#21262d',
                      color: '#e6edf3',
                      border: '1px solid #30363d',
                      borderRadius: '6px',
                      padding: '5px 10px',
                      fontSize: '0.74rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Configure Alerts →
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── TAB 2: CAREGIVER ALERTS ──────────────────────────────────────── */}
        {activeTab === 'alerts' && (
          <div id="alerts-section" style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {/* Action Bar */}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '10px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                <span style={{ fontSize: '1rem', fontWeight: 600, color: '#e6edf3' }}>
                  Alert History ({alerts.length})
                </span>
                {unackAlertCount > 0 && (
                  <span
                    style={{
                      fontSize: '0.72rem',
                      backgroundColor: '#da3633',
                      color: '#ffffff',
                      borderRadius: '999px',
                      padding: '2px 8px',
                      fontWeight: 700,
                    }}
                  >
                    {unackAlertCount} Pending
                  </span>
                )}
              </div>

              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                <button
                  onClick={() => setNotificationSettingsOpen(!notificationSettingsOpen)}
                  style={{
                    backgroundColor: '#21262d',
                    color: '#e6edf3',
                    border: '1px solid #30363d',
                    borderRadius: '6px',
                    padding: '6px 12px',
                    fontSize: '0.78rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  🔔 {notificationSettingsOpen ? 'Hide Chime & Notification Config' : 'Configure Chime & Notifications'}
                </button>

                {unackAlertCount > 0 && (
                  <button
                    onClick={handleAcknowledgeAllAlerts}
                    style={{
                      backgroundColor: '#238636',
                      color: '#ffffff',
                      border: '1px solid #2ea043',
                      borderRadius: '6px',
                      padding: '6px 12px',
                      fontSize: '0.78rem',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    ✓ Acknowledge All ({unackAlertCount})
                  </button>
                )}

                <button
                  onClick={() => setOnlyUnackAlerts(!onlyUnackAlerts)}
                  style={{
                    backgroundColor: onlyUnackAlerts ? '#1f6feb' : '#21262d',
                    color: onlyUnackAlerts ? '#ffffff' : '#8b949e',
                    border: '1px solid #30363d',
                    borderRadius: '6px',
                    padding: '6px 12px',
                    fontSize: '0.78rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  {onlyUnackAlerts ? 'Showing Pending Only' : 'Show All'}
                </button>
              </div>
            </div>

            {/* Notification & Chime Settings Drawer */}
            {notificationSettingsOpen && (
              <div
                style={{
                  backgroundColor: '#161b22',
                  border: '1px solid #30363d',
                  borderRadius: '8px',
                  padding: '16px 20px',
                  display: 'grid',
                  gridTemplateColumns: '1fr 1fr',
                  gap: '20px',
                }}
              >
                {/* Desktop Notifications */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 600, color: '#e6edf3', fontSize: '0.85rem' }}>
                      🖥️ Desktop Browser Notifications
                    </span>
                    <span
                      style={{
                        fontSize: '0.7rem',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        backgroundColor: notificationPermission === 'granted' ? '#0d4429' : '#21262d',
                        color: notificationPermission === 'granted' ? '#3fb950' : '#8b949e',
                        border: '1px solid #30363d',
                        fontWeight: 600,
                      }}
                    >
                      {notificationPermission === 'granted' ? '✓ Permission Granted' : '○ Permission Needed'}
                    </span>
                  </div>
                  <div style={{ fontSize: '0.76rem', color: '#8b949e', lineHeight: 1.4 }}>
                    Dispatches OS-level notifications for critical sounds even when tab is backgrounded.
                  </div>
                  <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                    <button
                      onClick={handleToggleNotifications}
                      style={{
                        backgroundColor: notificationsEnabled ? '#238636' : '#21262d',
                        color: notificationsEnabled ? '#ffffff' : '#8b949e',
                        border: '1px solid #30363d',
                        borderRadius: '6px',
                        padding: '6px 10px',
                        fontSize: '0.74rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      {notificationsEnabled ? '🔔 Notifications: On' : '🔕 Notifications: Muted'}
                    </button>
                    {notificationPermission !== 'granted' && (
                      <button
                        onClick={handleRequestNotificationPermission}
                        style={{
                          backgroundColor: '#1f6feb',
                          color: '#ffffff',
                          border: 'none',
                          borderRadius: '6px',
                          padding: '6px 10px',
                          fontSize: '0.74rem',
                          fontWeight: 600,
                          cursor: 'pointer',
                        }}
                      >
                        Grant Permission
                      </button>
                    )}
                    <button
                      onClick={handleTestNotification}
                      style={{
                        backgroundColor: '#21262d',
                        color: '#58a6ff',
                        border: '1px solid #30363d',
                        borderRadius: '6px',
                        padding: '6px 10px',
                        fontSize: '0.74rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      Test Alert
                    </button>
                  </div>
                </div>

                {/* Audible Chime */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={{ fontWeight: 600, color: '#e6edf3', fontSize: '0.85rem' }}>
                      🔔 Audible Caregiver Chime
                    </span>
                    <span
                      style={{
                        fontSize: '0.7rem',
                        padding: '2px 6px',
                        borderRadius: '4px',
                        backgroundColor: chimeEnabled ? '#0d4429' : '#21262d',
                        color: chimeEnabled ? '#3fb950' : '#8b949e',
                        border: '1px solid #30363d',
                        fontWeight: 600,
                      }}
                    >
                      {chimeEnabled ? '🔊 Sound Active' : '🔇 Muted'}
                    </span>
                  </div>
                  <div style={{ fontSize: '0.76rem', color: '#8b949e', lineHeight: 1.4 }}>
                    Plays a gentle 2-tone melodic chime via Web Audio API. Never sounds for ordinary ambient noises.
                  </div>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginTop: '4px' }}>
                    <button
                      onClick={handleToggleChime}
                      style={{
                        backgroundColor: chimeEnabled ? '#238636' : '#21262d',
                        color: chimeEnabled ? '#ffffff' : '#8b949e',
                        border: '1px solid #30363d',
                        borderRadius: '6px',
                        padding: '6px 10px',
                        fontSize: '0.74rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      {chimeEnabled ? '🔊 Chime: On' : '🔇 Chime: Muted'}
                    </button>
                    <button
                      onClick={handleTestChime}
                      style={{
                        backgroundColor: '#21262d',
                        color: '#58a6ff',
                        border: '1px solid #30363d',
                        borderRadius: '6px',
                        padding: '6px 10px',
                        fontSize: '0.74rem',
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      ▶ Preview
                    </button>
                    <select
                      value={chimeSeverity}
                      onChange={(e) => {
                        const val = e.target.value as 'Critical' | 'High';
                        setChimeSeverity(val);
                        localStorage.setItem('echotrace_chime_severity', val);
                      }}
                      style={{
                        backgroundColor: '#21262d',
                        color: '#c9d1d9',
                        border: '1px solid #30363d',
                        borderRadius: '6px',
                        padding: '5px 8px',
                        fontSize: '0.74rem',
                      }}
                    >
                      <option value="Critical">Critical Only</option>
                      <option value="High">Critical & High</option>
                    </select>
                  </div>
                </div>
              </div>
            )}

            {testNotificationFeedback && (
              <div
                style={{
                  padding: '8px 12px',
                  backgroundColor: testNotificationFeedback.startsWith('✓') ? '#0d4429' : '#271d0a',
                  border: `1px solid ${testNotificationFeedback.startsWith('✓') ? '#238636' : '#9e6a03'}`,
                  borderRadius: '6px',
                  fontSize: '0.76rem',
                  color: testNotificationFeedback.startsWith('✓') ? '#3fb950' : '#e3b341',
                }}
              >
                {testNotificationFeedback}
              </div>
            )}

            {/* Alerts Table */}
            {alerts.length > 0 ? (
              <div style={{ backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px', overflow: 'hidden' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.8rem' }}>
                  <thead>
                    <tr style={{ backgroundColor: '#21262d', color: '#8b949e', borderBottom: '1px solid #30363d' }}>
                      <th style={{ padding: '8px 12px' }}>Severity</th>
                      <th style={{ padding: '8px 12px' }}>Alert Type</th>
                      <th style={{ padding: '8px 12px' }}>Room</th>
                      <th style={{ padding: '8px 12px' }}>Timestamp</th>
                      <th style={{ padding: '8px 12px' }}>Source</th>
                      <th style={{ padding: '8px 12px' }}>Status</th>
                      <th style={{ padding: '8px 12px', textAlign: 'right' }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {alerts
                      .filter((al) => !onlyUnackAlerts || al.acknowledged === 0)
                      .map((al) => {
                        const severityColor =
                          al.severity === 'Critical'
                            ? '#f85149'
                            : al.severity === 'High'
                            ? '#e3b341'
                            : al.severity === 'Medium'
                            ? '#58a6ff'
                            : '#8b949e';

                        return (
                          <tr
                            key={al.id}
                            id={`alert-row-${al.id}`}
                            style={{
                              borderBottom: '1px solid #21262d',
                              backgroundColor: al.acknowledged ? 'transparent' : 'rgba(248, 81, 73, 0.05)',
                            }}
                          >
                            <td style={{ padding: '8px 12px' }}>
                              <span
                                style={{
                                  color: severityColor,
                                  fontWeight: 700,
                                  fontSize: '0.72rem',
                                  border: `1px solid ${severityColor}`,
                                  padding: '2px 6px',
                                  borderRadius: '4px',
                                }}
                              >
                                {al.severity}
                              </span>
                            </td>
                            <td style={{ padding: '8px 12px', color: '#ffffff', fontWeight: 500 }}>
                              <div>{al.alert_type}</div>
                              <div style={{ fontSize: '0.72rem', color: '#8b949e', marginTop: '2px' }}>
                                {al.description}
                              </div>
                            </td>
                            <td style={{ padding: '8px 12px', color: '#c9d1d9' }}>
                              {al.room ? `📍 ${al.room}` : '—'}
                            </td>
                            <td style={{ padding: '8px 12px', color: '#8b949e' }}>{formatDateTime(al.timestamp)}</td>
                            <td style={{ padding: '8px 12px' }}>
                              <span
                                style={{
                                  fontSize: '0.7rem',
                                  padding: '2px 6px',
                                  borderRadius: '4px',
                                  backgroundColor: al.source === 'microphone' ? '#0d4429' : '#21262d',
                                  color: al.source === 'microphone' ? '#3fb950' : '#e3b341',
                                  border: '1px solid #30363d',
                                }}
                              >
                                {al.source === 'microphone' ? '🎙️ Mic' : '⚡ Sim'}
                              </span>
                            </td>
                            <td style={{ padding: '8px 12px' }}>
                              {al.acknowledged ? (
                                <span style={{ color: '#3fb950', fontSize: '0.75rem', fontWeight: 500 }}>✓ Acknowledged</span>
                              ) : (
                                <span style={{ color: '#f85149', fontWeight: 600, fontSize: '0.75rem' }}>● Pending</span>
                              )}
                            </td>
                            <td style={{ padding: '8px 12px', textAlign: 'right' }}>
                              {!al.acknowledged && (
                                <button
                                  onClick={() => handleAcknowledgeAlert(al.id)}
                                  style={{
                                    backgroundColor: '#21262d',
                                    color: '#58a6ff',
                                    border: '1px solid #30363d',
                                    borderRadius: '4px',
                                    padding: '4px 8px',
                                    fontSize: '0.72rem',
                                    fontWeight: 600,
                                    cursor: 'pointer',
                                  }}
                                >
                                  Acknowledge
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div style={{ padding: '24px', backgroundColor: '#161b22', borderRadius: '8px', color: '#8b949e', textAlign: 'center', fontSize: '0.85rem' }}>
                ✓ No caregiver alerts recorded. Urgent sounds (e.g., smoke alarm, glass breaking) will appear here.
              </div>
            )}
          </div>
        )}

        {/* ── TAB 3: DAILY ACTIVITIES ──────────────────────────────────────── */}
        {activeTab === 'activities' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <h3 style={{ fontSize: '0.98rem', fontWeight: 600, color: '#e6edf3', margin: 0 }}>
                  🧠 Interpreted Daily Routines ({activities.length})
                </h3>
                <div style={{ fontSize: '0.78rem', color: '#8b949e', marginTop: '2px' }}>
                  EchoTrace groups sequences of related domestic sounds into daily habits (meal prep, hygiene, transitions).
                </div>
              </div>
            </div>

            {activities.length > 0 ? (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '12px' }}>
                {activities.map((act) => {
                  const eventCount = JSON.parse(act.related_event_ids || '[]').length;
                  return (
                    <div
                      key={act.id}
                      style={{
                        backgroundColor: '#161b22',
                        border: '1px solid #30363d',
                        borderRadius: '8px',
                        padding: '14px 16px',
                        borderLeft: '3px solid #3fb950',
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                        <strong style={{ color: '#ffffff', fontSize: '0.92rem' }}>{act.activity_type}</strong>
                        <span
                          style={{
                            fontSize: '0.7rem',
                            backgroundColor: '#21262d',
                            color: '#58a6ff',
                            padding: '2px 8px',
                            borderRadius: '4px',
                          }}
                        >
                          📍 {act.room}
                        </span>
                      </div>
                      <div style={{ fontSize: '0.8rem', color: '#c9d1d9', lineHeight: 1.4, marginBottom: '8px' }}>
                        {act.description}
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.74rem', color: '#8b949e' }}>
                        <span>🕐 {formatTime(act.start_time)} – {formatTime(act.end_time)}</span>
                        <span>{eventCount} supporting sound(s)</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div style={{ padding: '24px', backgroundColor: '#161b22', borderRadius: '8px', color: '#8b949e', textAlign: 'center', fontSize: '0.85rem' }}>
                No daily activities interpreted yet. As multiple sounds occur in a room (e.g. footsteps + water + dishes in Kitchen), routine patterns will form here.
              </div>
            )}
          </div>
        )}

        {/* ── TAB 4: HISTORY & SEARCH ──────────────────────────────────────── */}
        {activeTab === 'history' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
            {/* Filter Bar */}
            <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap' }}>
              <input
                type="text"
                placeholder="Search sounds (e.g., door, keys, speech, water)…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                style={{
                  flex: 1,
                  minWidth: '200px',
                  backgroundColor: '#21262d',
                  border: '1px solid #30363d',
                  color: '#e6edf3',
                  borderRadius: '6px',
                  padding: '8px 12px',
                  fontSize: '0.85rem',
                  outline: 'none',
                }}
              />
              <select
                value={searchRoom}
                onChange={(e) => setSearchRoom(e.target.value)}
                style={{
                  backgroundColor: '#21262d',
                  color: '#e6edf3',
                  border: '1px solid #30363d',
                  borderRadius: '6px',
                  padding: '8px 10px',
                  fontSize: '0.85rem',
                  outline: 'none',
                  cursor: 'pointer',
                }}
              >
                <option value="All Rooms">All Rooms</option>
                {allRooms.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
              <select
                value={searchSource}
                onChange={(e) => setSearchSource(e.target.value)}
                style={{
                  backgroundColor: '#21262d',
                  color: '#e6edf3',
                  border: '1px solid #30363d',
                  borderRadius: '6px',
                  padding: '8px 10px',
                  fontSize: '0.85rem',
                  outline: 'none',
                  cursor: 'pointer',
                }}
              >
                <option value="All">All Sources</option>
                <option value="microphone">Real Mic</option>
                <option value="simulator">Simulator</option>
              </select>
              <select
                value={searchSession}
                onChange={(e) => setSearchSession(e.target.value)}
                style={{
                  backgroundColor: '#21262d',
                  color: '#e6edf3',
                  border: '1px solid #30363d',
                  borderRadius: '6px',
                  padding: '8px 10px',
                  fontSize: '0.85rem',
                  outline: 'none',
                  cursor: 'pointer',
                }}
              >
                <option value="All">All Sessions</option>
                <option value={clientSessionId}>Current Tab</option>
              </select>
            </div>

            {/* Search Results Table */}
            {searchQuery.trim() || searchRoom !== 'All Rooms' || searchSource !== 'All' || searchSession !== 'All' ? (
              searchResults.length > 0 ? (
                <div style={{ backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px', overflow: 'hidden' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.8rem' }}>
                    <thead>
                      <tr style={{ backgroundColor: '#21262d', color: '#8b949e', borderBottom: '1px solid #30363d' }}>
                        <th style={{ padding: '8px 12px' }}>Timestamp</th>
                        <th style={{ padding: '8px 12px' }}>Room</th>
                        <th style={{ padding: '8px 12px' }}>Sound Class</th>
                        <th style={{ padding: '8px 12px' }}>Source</th>
                        <th style={{ padding: '8px 12px' }}>Session</th>
                        <th style={{ padding: '8px 12px', textAlign: 'right' }}>Confidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {searchResults.map((ev) => (
                        <tr key={ev.id} style={{ borderBottom: '1px solid #21262d' }}>
                          <td style={{ padding: '8px 12px', color: '#8b949e' }}>{formatDateTime(ev.timestamp)}</td>
                          <td style={{ padding: '8px 12px', color: '#e6edf3' }}>{ev.room}</td>
                          <td style={{ padding: '8px 12px', color: '#58a6ff', fontWeight: 500 }}>{ev.sound_class}</td>
                          <td style={{ padding: '8px 12px' }}>
                            <span style={{ color: ev.source === 'microphone' ? '#3fb950' : '#8b949e' }}>
                              {ev.source === 'microphone' ? '🎙️ Mic' : '⚡ Sim'}
                            </span>
                          </td>
                          <td style={{ padding: '8px 12px', fontFamily: 'monospace', fontSize: '0.75rem', color: '#8b949e' }}>
                            {(ev.client_session_id || ev.session_id) ? (
                              <span style={{ color: (ev.client_session_id || ev.session_id) === clientSessionId ? '#58a6ff' : '#8b949e' }}>
                                {(ev.client_session_id || ev.session_id || '').slice(0, 8)}
                              </span>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: '#3fb950' }}>
                            {Math.round(ev.confidence * 100)}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div style={{ padding: '16px', backgroundColor: '#161b22', borderRadius: '8px', color: '#8b949e', textAlign: 'center', fontSize: '0.82rem' }}>
                  No events found matching the current search filters.
                </div>
              )
            ) : null}

            {/* Full SQLite Event Log Expander */}
            <div style={{ border: '1px solid #30363d', borderRadius: '8px', overflow: 'hidden' }}>
              <button
                onClick={() => {
                  const next = !fullLogOpen;
                  setFullLogOpen(next);
                  if (next) refreshAllEvents();
                }}
                style={{
                  width: '100%',
                  backgroundColor: '#161b22',
                  color: '#e6edf3',
                  border: 'none',
                  padding: '10px 14px',
                  textAlign: 'left',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                }}
              >
                <span>📜 Full Event Log from SQLite (last 100)</span>
                <span style={{ color: '#8b949e', fontSize: '0.8rem' }}>{fullLogOpen ? '▲ Hide' : '▼ View'}</span>
              </button>
              {fullLogOpen && (
                <div style={{ backgroundColor: '#0d1117', borderTop: '1px solid #30363d', maxHeight: '360px', overflowY: 'auto' }}>
                  {allEvents.length > 0 ? (
                    <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.8rem' }}>
                      <thead>
                        <tr style={{ backgroundColor: '#161b22', color: '#8b949e', borderBottom: '1px solid #30363d' }}>
                          <th style={{ padding: '8px 12px' }}>ID</th>
                          <th style={{ padding: '8px 12px' }}>Timestamp</th>
                          <th style={{ padding: '8px 12px' }}>Room</th>
                          <th style={{ padding: '8px 12px' }}>Sound Class</th>
                          <th style={{ padding: '8px 12px' }}>Duration</th>
                          <th style={{ padding: '8px 12px' }}>Source</th>
                          <th style={{ padding: '8px 12px', textAlign: 'right' }}>Confidence</th>
                        </tr>
                      </thead>
                      <tbody>
                        {allEvents.map((ev) => (
                          <tr key={ev.id} style={{ borderBottom: '1px solid #21262d' }}>
                            <td style={{ padding: '8px 12px', color: '#8b949e' }}>#{ev.id}</td>
                            <td style={{ padding: '8px 12px', color: '#8b949e' }}>{formatDateTime(ev.timestamp)}</td>
                            <td style={{ padding: '8px 12px', color: '#e6edf3' }}>{ev.room}</td>
                            <td style={{ padding: '8px 12px', color: '#58a6ff', fontWeight: 500 }}>{ev.sound_class}</td>
                            <td style={{ padding: '8px 12px', color: '#8b949e' }}>{ev.duration}s</td>
                            <td style={{ padding: '8px 12px' }}>
                              <span style={{ color: ev.source === 'microphone' ? '#3fb950' : '#8b949e' }}>
                                {ev.source === 'microphone' ? '🎙️ Mic' : '⚡ Sim'}
                              </span>
                            </td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: '#3fb950' }}>
                              {Math.round(ev.confidence * 100)}%
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  ) : (
                    <div style={{ padding: '16px', color: '#8b949e', fontSize: '0.82rem' }}>No events recorded yet.</div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── TAB 5: INSIGHTS & ANALYTICS ─────────────────────────────────── */}
        {activeTab === 'analytics' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px' }}>
            {/* Time of Day */}
            <div style={{ backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px', padding: '16px 18px' }}>
              <h4 style={{ margin: '0 0 12px 0', fontSize: '0.9rem', color: '#e6edf3' }}>
                🕒 Time-of-Day Activity Patterns
              </h4>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '8px', textAlign: 'center' }}>
                <div style={{ backgroundColor: '#21262d', padding: '10px 8px', borderRadius: '6px' }}>
                  <div style={{ fontSize: '0.7rem', color: '#8b949e' }}>Morning (6-12)</div>
                  <div style={{ fontSize: '1.2rem', fontWeight: 700, color: '#e6edf3', marginTop: '4px' }}>
                    {stats.timeOfDay?.morning || 0}
                  </div>
                </div>
                <div style={{ backgroundColor: '#21262d', padding: '10px 8px', borderRadius: '6px' }}>
                  <div style={{ fontSize: '0.7rem', color: '#8b949e' }}>Afternoon (12-18)</div>
                  <div style={{ fontSize: '1.2rem', fontWeight: 700, color: '#e6edf3', marginTop: '4px' }}>
                    {stats.timeOfDay?.afternoon || 0}
                  </div>
                </div>
                <div style={{ backgroundColor: '#21262d', padding: '10px 8px', borderRadius: '6px' }}>
                  <div style={{ fontSize: '0.7rem', color: '#8b949e' }}>Evening (18-24)</div>
                  <div style={{ fontSize: '1.2rem', fontWeight: 700, color: '#e6edf3', marginTop: '4px' }}>
                    {stats.timeOfDay?.evening || 0}
                  </div>
                </div>
                <div style={{ backgroundColor: '#21262d', padding: '10px 8px', borderRadius: '6px' }}>
                  <div style={{ fontSize: '0.7rem', color: '#8b949e' }}>Night (0-6)</div>
                  <div style={{ fontSize: '1.2rem', fontWeight: 700, color: '#e6edf3', marginTop: '4px' }}>
                    {stats.timeOfDay?.night || 0}
                  </div>
                </div>
              </div>
            </div>

            {/* Room Distribution */}
            <div style={{ backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '8px', padding: '16px 18px' }}>
              <h4 style={{ margin: '0 0 12px 0', fontSize: '0.9rem', color: '#e6edf3' }}>
                📍 Room-wise Sound Distribution
              </h4>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {stats.roomDistribution && stats.roomDistribution.length > 0 ? (
                  stats.roomDistribution.slice(0, 5).map((r) => (
                    <div key={r.room}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.74rem', marginBottom: '2px' }}>
                        <span style={{ color: '#e6edf3' }}>{r.room}</span>
                        <span style={{ color: '#8b949e' }}>
                          {r.count} ({r.percentage}%)
                        </span>
                      </div>
                      <div style={{ height: '6px', backgroundColor: '#21262d', borderRadius: '3px', overflow: 'hidden' }}>
                        <div style={{ width: `${r.percentage}%`, height: '100%', backgroundColor: '#58a6ff' }} />
                      </div>
                    </div>
                  ))
                ) : (
                  <div style={{ color: '#8b949e', fontSize: '0.78rem' }}>No room data yet.</div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* Footer */}
        <footer
          style={{
            textAlign: 'center',
            color: '#484f58',
            fontSize: '0.74rem',
            marginTop: 'auto',
            paddingTop: '16px',
            borderTop: '1px solid #21262d',
          }}
        >
          EchoTrace · 100% on-device AI classification · SQLite local persistence · No raw audio is ever recorded or uploaded
        </footer>
      </main>

      {/* ── PRIVACY GUARANTEE MODAL ────────────────────────────────────────── */}
      {infoModalOpen === 'privacy' && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              backgroundColor: '#161b22',
              border: '1px solid #30363d',
              borderRadius: '10px',
              padding: '24px',
              maxWidth: '480px',
              width: '90%',
            }}
          >
            <h3 style={{ margin: '0 0 10px 0', color: '#ffffff', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>🔒</span> Privacy & Security Architecture
            </h3>
            <p style={{ fontSize: '0.85rem', color: '#c9d1d9', lineHeight: 1.6, margin: '0 0 14px 0' }}>
              EchoTrace was built specifically for privacy in residential and caregiving environments:
            </p>
            <ul style={{ fontSize: '0.82rem', color: '#8b949e', lineHeight: 1.6, paddingLeft: '20px', margin: '0 0 20px 0' }}>
              <li><strong>Zero Raw Audio Storage:</strong> Audio frames are processed entirely in volatile RAM (1-second windows) and immediately discarded.</li>
              <li><strong>No Cloud Transmissions:</strong> Neural network inference runs locally on this device via Google YAMNet.</li>
              <li><strong>Metadata Only:</strong> Only the sound category (e.g., "Knock"), confidence score, timestamp, and room label are stored in the local SQLite database (<code style={{ color: '#58a6ff' }}>echotrace.db</code>).</li>
            </ul>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setInfoModalOpen(null)}
                style={{
                  backgroundColor: '#21262d',
                  color: '#e6edf3',
                  border: '1px solid #30363d',
                  borderRadius: '6px',
                  padding: '8px 16px',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── MONITORED SOUND CLASSES MODAL ──────────────────────────────────── */}
      {infoModalOpen === 'monitored' && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              backgroundColor: '#161b22',
              border: '1px solid #30363d',
              borderRadius: '10px',
              padding: '24px',
              maxWidth: '520px',
              width: '90%',
            }}
          >
            <h3 style={{ margin: '0 0 8px 0', color: '#ffffff', display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span>📋</span> Monitored Acoustic Classes ({TARGET_CLASSES.length})
            </h3>
            <p style={{ fontSize: '0.8rem', color: '#8b949e', margin: '0 0 14px 0' }}>
              EchoTrace filters raw 521 AudioSet classifications into focused domestic and safety events:
            </p>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr 1fr',
                gap: '8px',
                maxHeight: '260px',
                overflowY: 'auto',
                padding: '8px',
                backgroundColor: '#0d1117',
                borderRadius: '6px',
                border: '1px solid #30363d',
                marginBottom: '16px',
                fontSize: '0.78rem',
                color: '#c9d1d9',
              }}
            >
              {[...TARGET_CLASSES].sort().map((c) => (
                <div key={c} style={{ padding: '2px 4px' }}>• {c}</div>
              ))}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <button
                onClick={() => setInfoModalOpen(null)}
                style={{
                  backgroundColor: '#21262d',
                  color: '#e6edf3',
                  border: '1px solid #30363d',
                  borderRadius: '6px',
                  padding: '8px 16px',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── RESET CONFIRMATION MODAL ───────────────────────────────────────── */}
      {resetModalOpen && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              backgroundColor: '#161b22',
              border: '1px solid #30363d',
              borderRadius: '10px',
              padding: '24px',
              maxWidth: '420px',
              width: '90%',
            }}
          >
            <h3 style={{ margin: '0 0 10px 0', color: '#ffffff' }}>🔄 Reset Sample Data?</h3>
            <p style={{ fontSize: '0.85rem', color: '#8b949e', lineHeight: 1.5, margin: '0 0 20px 0' }}>
              This will populate the database with a fresh set of realistic morning routines, caregiver alerts, and activity patterns.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button
                onClick={() => setResetModalOpen(false)}
                style={{
                  backgroundColor: '#21262d',
                  color: '#e6edf3',
                  border: '1px solid #30363d',
                  borderRadius: '6px',
                  padding: '8px 14px',
                  fontSize: '0.85rem',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleResetSampleData}
                style={{
                  backgroundColor: '#238636',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '8px 14px',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Confirm Reset
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── CLEAR HISTORY CONFIRMATION MODAL ───────────────────────────────── */}
      {clearModalOpen && (
        <div
          style={{
            position: 'fixed',
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: 'rgba(0,0,0,0.7)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 1000,
          }}
        >
          <div
            style={{
              backgroundColor: '#161b22',
              border: '1px solid #30363d',
              borderRadius: '10px',
              padding: '24px',
              maxWidth: '420px',
              width: '90%',
            }}
          >
            <h3 style={{ margin: '0 0 10px 0', color: '#f85149' }}>🗑️ Clear All History?</h3>
            <p style={{ fontSize: '0.85rem', color: '#8b949e', lineHeight: 1.5, margin: '0 0 20px 0' }}>
              Are you sure you want to permanently clear all events, interpreted activities, and caregiver alerts from the local SQLite database? This cannot be undone.
            </p>
            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
              <button
                onClick={() => setClearModalOpen(false)}
                style={{
                  backgroundColor: '#21262d',
                  color: '#e6edf3',
                  border: '1px solid #30363d',
                  borderRadius: '6px',
                  padding: '8px 14px',
                  fontSize: '0.85rem',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                onClick={handleClearHistory}
                style={{
                  backgroundColor: '#da3633',
                  color: '#ffffff',
                  border: 'none',
                  borderRadius: '6px',
                  padding: '8px 14px',
                  fontSize: '0.85rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                Permanently Clear
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Centralized Settings Modal ────────────────────────────────────── */}
      <SettingsModal
        isOpen={settingsModalOpen}
        onClose={() => setSettingsModalOpen(false)}
        onSettingsSaved={handleSettingsSaved}
        currentRoom={room}
      />
    </div>
  );
}
