import React, { useState, useEffect, useRef, useMemo } from 'react';
import { ROOMS, TARGET_CLASSES } from './config';
import type { SoundEvent, Activity, Alert, StatsData, AiStatus } from './types';

export default function App() {
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

  // Web Audio refs for real microphone capture
  const audioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const audioBufferRef = useRef<number[]>([]);
  const isClassifyingRef = useRef<boolean>(false);

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

  const refreshAlerts = async () => {
    try {
      const url = onlyUnackAlerts ? '/api/alerts?onlyUnacknowledged=true' : '/api/alerts';
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json();
        setAlerts(data.alerts || []);
        setUnackAlertCount(data.unacknowledgedCount || 0);
      }
    } catch {
      // ignore
    }
  };

  // Initial load
  useEffect(() => {
    checkAiStatus();
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
    if (!searchQuery.trim() && searchRoom === 'All Rooms' && searchSource === 'All') {
      setSearchResults([]);
      return;
    }

    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams();
        if (searchQuery.trim()) params.set('q', searchQuery.trim());
        if (searchRoom !== 'All Rooms') params.set('room', searchRoom);
        if (searchSource !== 'All') params.set('source', searchSource);
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
  }, [searchQuery, searchRoom, searchSource]);

  // ── Real Microphone Web Audio Pipeline ────────────────────────────────────

  const startAudioCapture = async () => {
    setMicError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      mediaStreamRef.current = stream;
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      const audioCtx = new AudioCtx({ sampleRate: 16000 });
      audioContextRef.current = audioCtx;

      const source = audioCtx.createMediaStreamSource(stream);
      // ScriptProcessor to gather real 1-second audio chunks (16,000 samples)
      const bufferSize = 4096;
      const processor = audioCtx.createScriptProcessor(bufferSize, 1, 1);
      scriptProcessorRef.current = processor;

      audioBufferRef.current = [];

      processor.onaudioprocess = async (e) => {
        const inputData = e.inputBuffer.getChannelData(0);

        // Calculate visual audio level
        let sum = 0;
        for (let i = 0; i < inputData.length; i++) {
          sum += Math.abs(inputData[i]);
          audioBufferRef.current.push(inputData[i]);
        }
        const avg = sum / inputData.length;
        setAudioLevel(Math.min(100, Math.round(avg * 300)));

        // Once we have accumulated ~1 second of 16kHz audio (16,000 samples)
        if (audioBufferRef.current.length >= 16000 && !isClassifyingRef.current) {
          const chunkToSend = audioBufferRef.current.slice(0, 16000);
          audioBufferRef.current = []; // reset for next second

          // Check if chunk has meaningful energy to avoid classifying pure silence
          const rms = Math.sqrt(chunkToSend.reduce((acc, v) => acc + v * v, 0) / chunkToSend.length);
          if (rms > 0.015) {
            isClassifyingRef.current = true;
            try {
              const res = await fetch('/api/ai/classify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  samples: chunkToSend,
                  room,
                  source: 'microphone',
                }),
              });

              if (res.ok) {
                const data = await res.json();
                if (data.detected && data.eventResult?.event) {
                  const ev = data.eventResult.event;
                  setRecentEvents((prev) => [ev, ...prev.filter((p) => p.id !== ev.id).slice(0, 7)]);
                  setSessionCounts((prev) => ({
                    ...prev,
                    [ev.sound_class]: (prev[ev.sound_class] || 0) + 1,
                  }));
                  refreshStats();
                  refreshActivities();
                  refreshAlerts();
                }
              }
            } catch (err) {
              console.warn('Inference request failed:', err);
            } finally {
              isClassifyingRef.current = false;
            }
          }
        }
      };

      source.connect(processor);
      processor.connect(audioCtx.destination);

      setIsListening(true);
    } catch (err: any) {
      console.warn('Microphone error:', err);
      setMicError(`Microphone unavailable: ${err.message}. You can use the Quick Sound Simulator to test detections.`);
      setIsListening(false);
    }
  };

  const stopAudioCapture = () => {
    setIsListening(false);
    setAudioLevel(0);
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    audioBufferRef.current = [];
  };

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
      };

      const res = await fetch('/api/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const result = await res.json();
        if (result.event) {
          const ev = result.event;
          setRecentEvents((prev) => [ev, ...prev.filter((p) => p.id !== ev.id).slice(0, 7)]);
          setSessionCounts((prev) => ({
            ...prev,
            [ev.sound_class]: (prev[ev.sound_class] || 0) + 1,
          }));
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
    <div style={{ display: 'flex', minHeight: '100vh', backgroundColor: '#0d1117', color: '#e6edf3' }}>
      {/* ── SIDEBAR ────────────────────────────────────────────────────────── */}
      <aside
        style={{
          width: '320px',
          minWidth: '290px',
          backgroundColor: '#161b22',
          borderRight: '1px solid #30363d',
          padding: '24px 20px',
          boxSizing: 'border-box',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
        }}
      >
        <div>
          <h2 style={{ margin: '0 0 4px 0', fontSize: '1.4rem', fontWeight: 700, color: '#ffffff' }}>
            🎧 EchoTrace
          </h2>
          <div style={{ fontSize: '0.82rem', color: '#8b949e', lineHeight: 1.4 }}>
            Privacy-first ambient sound memory for dementia caregivers.
          </div>
        </div>

        <hr style={{ border: 'none', borderTop: '1px solid #30363d', margin: '2px 0' }} />

        {/* Room select */}
        <div>
          <label style={{ display: 'block', fontSize: '0.8rem', color: '#8b949e', marginBottom: '6px', fontWeight: 600 }}>
            📍 Room
          </label>
          <select
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            style={{
              width: '100%',
              backgroundColor: '#21262d',
              color: '#e6edf3',
              border: '1px solid #30363d',
              borderRadius: '8px',
              padding: '8px 12px',
              fontSize: '0.9rem',
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

        <hr style={{ border: 'none', borderTop: '1px solid #30363d', margin: '2px 0' }} />

        {/* Model status */}
        <div>
          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#e6edf3', marginBottom: '6px' }}>
            🧠 Model
          </div>
          {aiStatus.ready ? (
            <span
              style={{
                display: 'inline-block',
                padding: '4px 12px',
                borderRadius: '999px',
                fontSize: '0.78rem',
                fontWeight: 600,
                letterSpacing: '0.04em',
                backgroundColor: '#0d2d6e',
                color: '#58a6ff',
                border: '1px solid #1f6feb',
              }}
            >
              ✓ YAMNet Ready
            </span>
          ) : (
            <span
              style={{
                display: 'inline-block',
                padding: '4px 12px',
                borderRadius: '999px',
                fontSize: '0.78rem',
                fontWeight: 600,
                backgroundColor: '#271d0a',
                color: '#e3b341',
                border: '1px solid #9e6a03',
              }}
            >
              ⏳ Connecting YAMNet…
            </span>
          )}
        </div>

        {/* Microphone controls */}
        <div>
          <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#e6edf3', marginBottom: '6px' }}>
            🎙️ Microphone
          </div>

          <div style={{ marginBottom: '10px' }}>
            {isListening ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span
                  style={{
                    display: 'inline-block',
                    padding: '4px 12px',
                    borderRadius: '999px',
                    fontSize: '0.78rem',
                    fontWeight: 600,
                    letterSpacing: '0.04em',
                    backgroundColor: '#0d4429',
                    color: '#3fb950',
                    border: '1px solid #238636',
                  }}
                >
                  ● LIVE
                </span>
                <span style={{ fontSize: '0.75rem', color: '#8b949e' }}>
                  Signal: {audioLevel}%
                </span>
              </div>
            ) : (
              <span
                style={{
                  display: 'inline-block',
                  padding: '4px 12px',
                  borderRadius: '999px',
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  letterSpacing: '0.04em',
                  backgroundColor: '#21262d',
                  color: '#8b949e',
                  border: '1px solid #30363d',
                }}
              >
                ○ Idle
              </span>
            )}
          </div>

          {isListening ? (
            <button
              onClick={stopAudioCapture}
              style={{
                width: '100%',
                backgroundColor: '#21262d',
                color: '#e6edf3',
                border: '1px solid #30363d',
                borderRadius: '8px',
                fontWeight: 600,
                padding: '9px 14px',
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
            >
              ⏹ Stop Listening
            </button>
          ) : (
            <button
              onClick={startAudioCapture}
              style={{
                width: '100%',
                backgroundColor: '#238636',
                borderColor: '#2ea043',
                color: '#ffffff',
                border: '1px solid #2ea043',
                borderRadius: '8px',
                fontWeight: 600,
                padding: '9px 14px',
                cursor: 'pointer',
                transition: 'all 0.2s',
              }}
            >
              ▶ Start Listening
            </button>
          )}

          {micError && (
            <div
              style={{
                marginTop: '8px',
                padding: '8px 10px',
                backgroundColor: '#271d0a',
                border: '1px solid #9e6a03',
                borderRadius: '6px',
                fontSize: '0.75rem',
                color: '#e3b341',
                lineHeight: 1.4,
              }}
            >
              ⚠ {micError}
            </div>
          )}
        </div>

        {/* Quick Sound Simulator */}
        <div style={{ border: '1px solid #30363d', borderRadius: '8px', overflow: 'hidden' }}>
          <button
            onClick={() => setSimulatorOpen(!simulatorOpen)}
            style={{
              width: '100%',
              backgroundColor: '#161b22',
              color: '#e6edf3',
              border: 'none',
              padding: '9px 12px',
              textAlign: 'left',
              fontSize: '0.82rem',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>⚡ Sound Simulator ({room})</span>
            <span style={{ color: '#8b949e', fontSize: '0.8rem' }}>{simulatorOpen ? '▲' : '▼'}</span>
          </button>
          {simulatorOpen && (
            <div style={{ padding: '10px', backgroundColor: '#0d1117', borderTop: '1px solid #30363d' }}>
              <div style={{ fontSize: '0.72rem', color: '#8b949e', marginBottom: '8px' }}>
                Simulated events are tagged with <span style={{ color: '#e3b341' }}>⚡ Simulated</span>:
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '6px' }}>
                {[
                  { label: '🔑 Keys jingling', conf: 0.94 },
                  { label: '🚪 Door knock', sound: 'Knock', conf: 0.88 },
                  { label: '💧 Water tap', sound: 'Water tap, faucet', conf: 0.91 },
                  { label: '🗣️ Speech', conf: 0.86 },
                  { label: '👣 Footsteps', conf: 0.79 },
                  { label: '☕ Coffee maker', conf: 0.92 },
                  { label: '🍽️ Dishes & pans', sound: 'Dishes, pots, and pans', conf: 0.89 },
                  { label: '🪟 Glass breaking', sound: 'Glass breaking', conf: 0.96 },
                  { label: '🚨 Smoke alarm', sound: 'Smoke detector, smoke alarm', conf: 0.98 },
                  { label: '🗄️ Drawer', conf: 0.84 },
                ].map((item) => (
                  <button
                    key={item.label}
                    onClick={() => triggerSimulatedSound(item.sound || item.label.replace(/^[\p{Emoji}\s]+/u, ''), item.conf)}
                    style={{
                      backgroundColor: '#21262d',
                      color: item.sound?.includes('alarm') || item.sound?.includes('Glass') ? '#f85149' : '#c9d1d9',
                      border: '1px solid #30363d',
                      borderRadius: '6px',
                      padding: '6px 8px',
                      fontSize: '0.72rem',
                      fontWeight: 500,
                      textAlign: 'left',
                      cursor: 'pointer',
                    }}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Privacy Expander */}
        <div style={{ border: '1px solid #30363d', borderRadius: '8px', overflow: 'hidden' }}>
          <button
            onClick={() => setPrivacyOpen(!privacyOpen)}
            style={{
              width: '100%',
              backgroundColor: '#161b22',
              color: '#e6edf3',
              border: 'none',
              padding: '9px 12px',
              textAlign: 'left',
              fontSize: '0.82rem',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>🔒 Privacy Guarantee</span>
            <span style={{ color: '#8b949e', fontSize: '0.8rem' }}>{privacyOpen ? '▲' : '▼'}</span>
          </button>
          {privacyOpen && (
            <div
              style={{
                padding: '10px 12px',
                backgroundColor: '#0d1117',
                borderTop: '1px solid #30363d',
                fontSize: '0.78rem',
                color: '#8b949e',
                lineHeight: 1.5,
              }}
            >
              <strong style={{ color: '#e6edf3' }}>No raw audio is stored or transmitted.</strong>
              <br />
              Audio is classified locally in 1-second memory chunks. Only event metadata (sound label, confidence %, timestamp, room) is saved to local SQLite (<code style={{ color: '#58a6ff' }}>echotrace.db</code>).
            </div>
          )}
        </div>

        {/* Monitored Sounds Expander */}
        <div style={{ border: '1px solid #30363d', borderRadius: '8px', overflow: 'hidden' }}>
          <button
            onClick={() => setMonitoredOpen(!monitoredOpen)}
            style={{
              width: '100%',
              backgroundColor: '#161b22',
              color: '#e6edf3',
              border: 'none',
              padding: '9px 12px',
              textAlign: 'left',
              fontSize: '0.82rem',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>📋 Monitored classes ({TARGET_CLASSES.length})</span>
            <span style={{ color: '#8b949e', fontSize: '0.8rem' }}>{monitoredOpen ? '▲' : '▼'}</span>
          </button>
          {monitoredOpen && (
            <div
              style={{
                padding: '10px 12px',
                backgroundColor: '#0d1117',
                borderTop: '1px solid #30363d',
                maxHeight: '160px',
                overflowY: 'auto',
                fontSize: '0.75rem',
                color: '#8b949e',
                lineHeight: 1.6,
              }}
            >
              {[...TARGET_CLASSES].sort().map((c) => (
                <div key={c}>• {c}</div>
              ))}
            </div>
          )}
        </div>

        {/* Database Management Tools */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: 'auto' }}>
          <button
            onClick={() => setResetModalOpen(true)}
            style={{
              backgroundColor: '#21262d',
              color: '#58a6ff',
              border: '1px solid #30363d',
              borderRadius: '6px',
              padding: '6px 10px',
              fontSize: '0.75rem',
              fontWeight: 600,
              cursor: 'pointer',
              textAlign: 'center',
            }}
          >
            🔄 Reset Sample Data
          </button>
          <button
            onClick={() => setClearModalOpen(true)}
            style={{
              backgroundColor: '#21262d',
              color: '#f85149',
              border: '1px solid #30363d',
              borderRadius: '6px',
              padding: '6px 10px',
              fontSize: '0.75rem',
              fontWeight: 600,
              cursor: 'pointer',
              textAlign: 'center',
            }}
          >
            🗑️ Clear History...
          </button>
        </div>
      </aside>

      {/* ── MAIN CONTENT ───────────────────────────────────────────────────── */}
      <main style={{ flex: 1, padding: '28px 36px', overflowY: 'auto' }}>
        {/* Active Alert Banner */}
        {topActiveAlert && (
          <div
            style={{
              backgroundColor: '#4d0000',
              border: '1px solid #f85149',
              borderRadius: '8px',
              padding: '14px 20px',
              marginBottom: '20px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              boxShadow: '0 4px 12px rgba(248,81,73,0.15)',
            }}
          >
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <span style={{ fontSize: '1.2rem' }}>⚠️</span>
                <strong style={{ color: '#ffffff', fontSize: '1rem' }}>
                  {topActiveAlert.alert_type} ({topActiveAlert.severity})
                </strong>
                <span
                  style={{
                    fontSize: '0.7rem',
                    padding: '2px 8px',
                    borderRadius: '4px',
                    backgroundColor: topActiveAlert.source === 'microphone' ? '#0d4429' : '#271d0a',
                    color: topActiveAlert.source === 'microphone' ? '#3fb950' : '#e3b341',
                    border: '1px solid currentColor',
                  }}
                >
                  {topActiveAlert.source === 'microphone' ? '🎙️ Real Mic' : '⚡ Simulated'}
                </span>
              </div>
              <div style={{ color: '#ffb3ba', fontSize: '0.85rem', marginTop: '4px' }}>
                {topActiveAlert.description} &nbsp;·&nbsp; {formatDateTime(topActiveAlert.timestamp)}
              </div>
            </div>
            <button
              onClick={() => handleAcknowledgeAlert(topActiveAlert.id)}
              style={{
                backgroundColor: '#f85149',
                color: '#ffffff',
                border: 'none',
                borderRadius: '6px',
                padding: '8px 16px',
                fontSize: '0.85rem',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              ✓ Acknowledge
            </button>
          </div>
        )}

        {/* Header */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '20px' }}>
          <div>
            <h1 style={{ margin: '0 0 6px 0', fontSize: '1.9rem', fontWeight: 700, color: '#ffffff' }}>
              🎧 EchoTrace
            </h1>
            <div style={{ fontSize: '0.92rem', color: '#8b949e' }}>
              Ambient sound memory assistant &nbsp;·&nbsp; Monitored Room: <strong style={{ color: '#e6edf3' }}>{room}</strong>
            </div>
          </div>

          {/* Export Report Action */}
          <a
            href="/api/reports/csv"
            download
            style={{
              backgroundColor: '#21262d',
              color: '#58a6ff',
              border: '1px solid #30363d',
              borderRadius: '8px',
              padding: '9px 16px',
              fontSize: '0.85rem',
              fontWeight: 600,
              textDecoration: 'none',
              display: 'inline-flex',
              alignItems: 'center',
              gap: '6px',
            }}
          >
            📥 Export CSV Report
          </a>
        </div>

        <hr style={{ border: 'none', borderTop: '1px solid #30363d', margin: '16px 0' }} />

        {/* ── Stats Row ────────────────────────────────────────────────────── */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(5, 1fr)',
            gap: '14px',
            marginBottom: '24px',
          }}
        >
          <div style={{ backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '10px', padding: '16px 18px' }}>
            <div style={{ color: '#8b949e', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>
              🔔 Total Events
            </div>
            <div style={{ color: '#ffffff', fontSize: '1.8rem', fontWeight: 700 }}>{stats.total}</div>
          </div>

          <div style={{ backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '10px', padding: '16px 18px' }}>
            <div style={{ color: '#8b949e', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>
              📅 Today
            </div>
            <div style={{ color: '#ffffff', fontSize: '1.8rem', fontWeight: 700 }}>{stats.today}</div>
          </div>

          <div style={{ backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '10px', padding: '16px 18px' }}>
            <div style={{ color: '#8b949e', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>
              📆 This Week
            </div>
            <div style={{ color: '#ffffff', fontSize: '1.8rem', fontWeight: 700 }}>{stats.thisWeek}</div>
          </div>

          <div style={{ backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '10px', padding: '16px 18px' }}>
            <div style={{ color: '#8b949e', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>
              🚨 Active Alerts
            </div>
            <div style={{ color: unackAlertCount > 0 ? '#f85149' : '#3fb950', fontSize: '1.8rem', fontWeight: 700 }}>
              {unackAlertCount}
            </div>
          </div>

          <div style={{ backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '10px', padding: '16px 18px' }}>
            <div style={{ color: '#8b949e', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: '4px' }}>
              🎙️ Status
            </div>
            <div style={{ color: isListening ? '#3fb950' : '#8b949e', fontSize: '1.8rem', fontWeight: 700 }}>
              {isListening ? 'LIVE' : 'Idle'}
            </div>
          </div>
        </div>

        <hr style={{ border: 'none', borderTop: '1px solid #30363d', margin: '20px 0' }} />

        {/* ── Live Feed & Session Counts (2 Columns) ────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: '24px', marginBottom: '28px' }}>
          {/* Column 1: Live Feed */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#c9d1d9', margin: 0 }}>
                🔴 Live Feed
              </h3>
              <span style={{ fontSize: '0.75rem', color: '#8b949e' }}>Auto-refreshes every 3s</span>
            </div>

            {recentEvents.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {recentEvents.map((ev) => (
                  <div
                    key={ev.id}
                    style={{
                      backgroundColor: '#161b22',
                      border: '1px solid #30363d',
                      borderLeft: '3px solid #58a6ff',
                      borderRadius: '8px',
                      padding: '12px 16px',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontSize: '0.98rem', fontWeight: 600, color: '#e6edf3' }}>
                          🔊 {ev.sound_class}
                        </span>
                        <span
                          style={{
                            fontSize: '0.68rem',
                            padding: '1px 6px',
                            borderRadius: '4px',
                            backgroundColor: ev.source === 'microphone' ? '#0d4429' : '#21262d',
                            color: ev.source === 'microphone' ? '#3fb950' : '#8b949e',
                            border: '1px solid #30363d',
                          }}
                        >
                          {ev.source === 'microphone' ? '🎙️ Mic' : '⚡ Sim'}
                        </span>
                        {ev.duration > 1 && (
                          <span style={{ fontSize: '0.72rem', color: '#8b949e' }}>
                            ⏱️ {ev.duration}s
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: '0.85rem', fontWeight: 600, color: '#58a6ff' }}>
                        {Math.round(ev.confidence * 100)}%
                      </div>
                    </div>
                    <div style={{ fontSize: '0.78rem', color: '#8b949e', marginTop: '4px' }}>
                      🕐 {formatTime(ev.timestamp)} &nbsp;|&nbsp; 📍 {ev.room}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div
                style={{
                  backgroundColor: '#0d2d6e',
                  border: '1px solid #1f6feb',
                  borderRadius: '8px',
                  padding: '16px 20px',
                  color: '#e6edf3',
                  fontSize: '0.88rem',
                }}
              >
                {isListening
                  ? '👂 Listening… No sounds detected yet. Try speaking, clapping, or click the Quick Sound Simulator in the sidebar!'
                  : 'No events recorded yet. Press ▶ Start Listening in the sidebar.'}
              </div>
            )}
          </div>

          {/* Column 2: Session Counts */}
          <div>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#c9d1d9', marginTop: 0, marginBottom: '12px' }}>
              📊 Sound Frequency
            </h3>

            {barChartData.length > 0 ? (
              <div
                style={{
                  backgroundColor: '#161b22',
                  border: '1px solid #30363d',
                  borderRadius: '10px',
                  padding: '16px 18px',
                }}
              >
                <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
                  {barChartData.map((item) => {
                    const pct = Math.max(8, Math.round((item.count / maxBarCount) * 100));
                    return (
                      <div key={item.sound}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '3px' }}>
                          <span style={{ color: '#e6edf3', fontWeight: 500 }}>{item.sound}</span>
                          <span style={{ color: '#58a6ff', fontWeight: 600 }}>{item.count}</span>
                        </div>
                        <div
                          style={{
                            height: '12px',
                            backgroundColor: '#21262d',
                            borderRadius: '4px',
                            overflow: 'hidden',
                          }}
                        >
                          <div
                            style={{
                              width: `${pct}%`,
                              height: '100%',
                              backgroundColor: '#58a6ff',
                              borderRadius: '4px',
                              transition: 'width 0.4s ease',
                            }}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : (
              <div style={{ color: '#8b949e', fontSize: '0.85rem' }}>
                Session counts will appear here once sounds are detected.
              </div>
            )}
          </div>
        </div>

        <hr style={{ border: 'none', borderTop: '1px solid #30363d', margin: '24px 0' }} />

        {/* ── Activity Intelligence Section ─────────────────────────────────── */}
        <div style={{ marginBottom: '28px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <div>
              <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#c9d1d9', margin: 0 }}>
                🧠 Activity Intelligence (Interpreted Daily Routines)
              </h3>
              <div style={{ fontSize: '0.78rem', color: '#8b949e', marginTop: '2px' }}>
                Combines related sounds into possible activities (e.g. meal prep, hygiene, room transitions).
              </div>
            </div>
            <span style={{ fontSize: '0.8rem', color: '#58a6ff' }}>{activities.length} routine(s) identified</span>
          </div>

          {activities.length > 0 ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))', gap: '12px' }}>
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
                    <div style={{ fontSize: '0.82rem', color: '#c9d1d9', lineHeight: 1.4, marginBottom: '8px' }}>
                      {act.description}
                    </div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.74rem', color: '#8b949e' }}>
                      <span>
                        🕐 {formatTime(act.start_time)} – {formatTime(act.end_time)}
                      </span>
                      <span>{eventCount} supporting sound(s)</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ padding: '14px', backgroundColor: '#161b22', borderRadius: '8px', color: '#8b949e', fontSize: '0.85rem' }}>
              No composite activities interpreted yet. As multiple sounds occur in a room (e.g., footsteps + water + dishes in Kitchen), activity routines will form here.
            </div>
          )}
        </div>

        <hr style={{ border: 'none', borderTop: '1px solid #30363d', margin: '24px 0' }} />

        {/* ── Caregiver Alerts Management ───────────────────────────────────── */}
        <div style={{ marginBottom: '28px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
            <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#c9d1d9', margin: 0 }}>
              🚨 Caregiver Alerts ({alerts.length})
            </h3>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                onClick={() => setOnlyUnackAlerts(!onlyUnackAlerts)}
                style={{
                  backgroundColor: onlyUnackAlerts ? '#0d2d6e' : '#21262d',
                  color: onlyUnackAlerts ? '#58a6ff' : '#8b949e',
                  border: '1px solid #30363d',
                  borderRadius: '6px',
                  padding: '4px 10px',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  cursor: 'pointer',
                }}
              >
                {onlyUnackAlerts ? 'Showing Unacknowledged Only' : 'Show All Alerts'}
              </button>
            </div>
          </div>

          {alerts.length > 0 ? (
            <div
              style={{
                backgroundColor: '#161b22',
                border: '1px solid #30363d',
                borderRadius: '8px',
                overflow: 'hidden',
                maxHeight: '260px',
                overflowY: 'auto',
              }}
            >
              <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.82rem' }}>
                <thead>
                  <tr style={{ backgroundColor: '#21262d', color: '#8b949e', borderBottom: '1px solid #30363d' }}>
                    <th style={{ padding: '8px 12px' }}>Severity</th>
                    <th style={{ padding: '8px 12px' }}>Alert Type</th>
                    <th style={{ padding: '8px 12px' }}>Timestamp</th>
                    <th style={{ padding: '8px 12px' }}>Source</th>
                    <th style={{ padding: '8px 12px' }}>Status</th>
                    <th style={{ padding: '8px 12px', textAlign: 'right' }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {alerts.map((al) => {
                    const severityColor =
                      al.severity === 'Critical'
                        ? '#f85149'
                        : al.severity === 'High'
                        ? '#e3b341'
                        : al.severity === 'Medium'
                        ? '#58a6ff'
                        : '#8b949e';

                    return (
                      <tr key={al.id} style={{ borderBottom: '1px solid #21262d' }}>
                        <td style={{ padding: '8px 12px' }}>
                          <span
                            style={{
                              color: severityColor,
                              fontWeight: 700,
                              fontSize: '0.75rem',
                              border: `1px solid ${severityColor}`,
                              padding: '2px 6px',
                              borderRadius: '4px',
                            }}
                          >
                            {al.severity}
                          </span>
                        </td>
                        <td style={{ padding: '8px 12px', color: '#ffffff', fontWeight: 500 }}>{al.alert_type}</td>
                        <td style={{ padding: '8px 12px', color: '#8b949e' }}>{formatDateTime(al.timestamp)}</td>
                        <td style={{ padding: '8px 12px' }}>
                          <span style={{ color: al.source === 'microphone' ? '#3fb950' : '#8b949e', fontSize: '0.72rem' }}>
                            {al.source === 'microphone' ? '🎙️ Mic' : '⚡ Sim'}
                          </span>
                        </td>
                        <td style={{ padding: '8px 12px' }}>
                          {al.acknowledged ? (
                            <span style={{ color: '#3fb950', fontSize: '0.75rem' }}>✓ Acknowledged</span>
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
            <div style={{ padding: '14px', backgroundColor: '#161b22', borderRadius: '8px', color: '#8b949e', fontSize: '0.85rem' }}>
              No alerts currently recorded. Urgent ambient sounds (e.g. smoke alarm, broken glass, loud crash) will generate notifications here.
            </div>
          )}
        </div>

        <hr style={{ border: 'none', borderTop: '1px solid #30363d', margin: '24px 0' }} />

        {/* ── Time-of-Day Insights & Room Distribution ─────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '20px', marginBottom: '28px' }}>
          {/* Time of Day */}
          <div style={{ backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '10px', padding: '16px 18px' }}>
            <h4 style={{ margin: '0 0 12px 0', fontSize: '0.95rem', color: '#c9d1d9' }}>
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
          <div style={{ backgroundColor: '#161b22', border: '1px solid #30363d', borderRadius: '10px', padding: '16px 18px' }}>
            <h4 style={{ margin: '0 0 12px 0', fontSize: '0.95rem', color: '#c9d1d9' }}>
              📍 Room-wise Distribution
            </h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {stats.roomDistribution && stats.roomDistribution.length > 0 ? (
                stats.roomDistribution.slice(0, 4).map((r) => (
                  <div key={r.room}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', marginBottom: '2px' }}>
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
                <div style={{ color: '#8b949e', fontSize: '0.8rem' }}>No room data yet.</div>
              )}
            </div>
          </div>
        </div>

        <hr style={{ border: 'none', borderTop: '1px solid #30363d', margin: '24px 0' }} />

        {/* ── Search Sound Timeline ────────────────────────────────────────── */}
        <div style={{ marginBottom: '28px' }}>
          <h3 style={{ fontSize: '1.1rem', fontWeight: 600, color: '#c9d1d9', marginTop: 0, marginBottom: '14px' }}>
            🔍 Search Sound Timeline
          </h3>

          <div style={{ display: 'flex', gap: '10px', marginBottom: '14px' }}>
            <input
              type="text"
              placeholder="e.g. door, keys, speech, cough, water…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{
                flex: 1,
                backgroundColor: '#21262d',
                border: '1px solid #30363d',
                color: '#e6edf3',
                borderRadius: '8px',
                padding: '9px 12px',
                fontSize: '0.88rem',
                outline: 'none',
              }}
            />
            <select
              value={searchRoom}
              onChange={(e) => setSearchRoom(e.target.value)}
              style={{
                width: '160px',
                backgroundColor: '#21262d',
                color: '#e6edf3',
                border: '1px solid #30363d',
                borderRadius: '8px',
                padding: '9px 10px',
                fontSize: '0.88rem',
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
                width: '140px',
                backgroundColor: '#21262d',
                color: '#e6edf3',
                border: '1px solid #30363d',
                borderRadius: '8px',
                padding: '9px 10px',
                fontSize: '0.88rem',
                outline: 'none',
                cursor: 'pointer',
              }}
            >
              <option value="All">All Sources</option>
              <option value="microphone">Real Mic</option>
              <option value="simulator">Simulator</option>
            </select>
          </div>

          {searchQuery.trim() || searchRoom !== 'All Rooms' || searchSource !== 'All' ? (
            searchResults.length > 0 ? (
              <div>
                <div
                  style={{
                    backgroundColor: '#161b22',
                    border: '1px solid #30363d',
                    borderRadius: '8px',
                    overflow: 'hidden',
                    maxHeight: '300px',
                    overflowY: 'auto',
                  }}
                >
                  <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.82rem' }}>
                    <thead>
                      <tr style={{ backgroundColor: '#21262d', color: '#8b949e', borderBottom: '1px solid #30363d' }}>
                        <th style={{ padding: '8px 12px' }}>Timestamp</th>
                        <th style={{ padding: '8px 12px' }}>Room</th>
                        <th style={{ padding: '8px 12px' }}>Sound Class</th>
                        <th style={{ padding: '8px 12px' }}>Source</th>
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
                          <td style={{ padding: '8px 12px', textAlign: 'right', color: '#3fb950' }}>
                            {Math.round(ev.confidence * 100)}%
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div style={{ fontSize: '0.78rem', color: '#8b949e', marginTop: '6px' }}>
                  Found <strong style={{ color: '#e6edf3' }}>{searchResults.length}</strong> result(s)
                </div>
              </div>
            ) : (
              <div
                style={{
                  backgroundColor: '#271d0a',
                  border: '1px solid #9e6a03',
                  borderRadius: '8px',
                  padding: '10px 14px',
                  color: '#e6edf3',
                  fontSize: '0.82rem',
                }}
              >
                No events found matching the current search filters.
              </div>
            )
          ) : (
            <div style={{ color: '#8b949e', fontSize: '0.8rem' }}>
              Type a keyword above, choose a room, or select a source to search the full sound timeline.
            </div>
          )}
        </div>

        <hr style={{ border: 'none', borderTop: '1px solid #30363d', margin: '24px 0' }} />

        {/* ── Full Event Log (last 100) ─────────────────────────────────────── */}
        <div style={{ border: '1px solid #30363d', borderRadius: '8px', overflow: 'hidden', marginBottom: '24px' }}>
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
              padding: '12px 16px',
              textAlign: 'left',
              fontSize: '0.92rem',
              fontWeight: 600,
              cursor: 'pointer',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
            }}
          >
            <span>📜 Full Event Log from SQLite (last 100)</span>
            <span style={{ color: '#8b949e', fontSize: '0.82rem' }}>{fullLogOpen ? '▲' : '▼'}</span>
          </button>
          {fullLogOpen && (
            <div style={{ backgroundColor: '#0d1117', borderTop: '1px solid #30363d', maxHeight: '360px', overflowY: 'auto' }}>
              {allEvents.length > 0 ? (
                <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.82rem' }}>
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
                <div style={{ padding: '16px', color: '#8b949e', fontSize: '0.85rem' }}>No events recorded yet.</div>
              )}
            </div>
          )}
        </div>

        {/* ── Footer ───────────────────────────────────────────────────────── */}
        <footer
          style={{
            textAlign: 'center',
            color: '#484f58',
            fontSize: '0.78rem',
            marginTop: '32px',
            paddingTop: '16px',
            borderTop: '1px solid #21262d',
          }}
        >
          EchoTrace · All audio processed on-device · SQLite local storage · No audio leaves this machine
        </footer>
      </main>

      {/* ── Reset Confirmation Modal ───────────────────────────────────────── */}
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

      {/* ── Clear History Confirmation Modal ───────────────────────────────── */}
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
    </div>
  );
}
