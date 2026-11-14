import React from 'react';
import type { Activity, AiStatus, Alert, SoundEvent, StatsData } from '../types';

interface OverviewDashboardProps {
  room: string;
  rooms: readonly string[];
  onRoomChange: (room: string) => void;
  isListening: boolean;
  audioLevel: number;
  micError: string | null;
  aiStatus: AiStatus;
  onStartListening: () => void;
  onStopListening: () => void;
  stats: StatsData;
  unackAlertCount: number;
  alerts: Alert[];
  recentEvents: SoundEvent[];
  activities: Activity[];
  barChartData: Array<{ sound: string; count: number }>;
  maxBarCount: number;
  simulatorOpen: boolean;
  onToggleSimulator: () => void;
  onTriggerSimulatedSound: (soundClass: string, confidence?: number) => void;
  onAcknowledgeAlert: (alertId: number) => void;
  onAcknowledgeAllAlerts: () => void;
  onTestChime: () => void;
  onNavigateTab: (tab: 'overview' | 'alerts' | 'activities' | 'history' | 'analytics') => void;
  formatTime: (ts: string) => string;
  formatDateTime: (ts: string) => string;
}

interface SimulatorItem {
  label: string;
  sound: string;
  conf: number;
  alertTag?: string;
}

const SIMULATOR_CATEGORIES: Array<{
  title: string;
  subtitle: string;
  items: SimulatorItem[];
}> = [
  {
    title: 'Safety & Urgent',
    subtitle: 'Triggers caregiver alerts',
    items: [
      { label: 'Smoke alarm', sound: 'Smoke detector, smoke alarm', conf: 0.98, alertTag: 'Critical' },
      { label: 'Glass breaking', sound: 'Glass breaking', conf: 0.96, alertTag: 'High Alert' },
    ],
  },
  {
    title: 'Home & Kitchen',
    subtitle: 'Daily household routines',
    items: [
      { label: 'Water tap', sound: 'Water tap, faucet', conf: 0.91 },
      { label: 'Coffee maker', sound: 'Coffee maker', conf: 0.92 },
      { label: 'Dishes & pans', sound: 'Dishes, pots, and pans', conf: 0.89 },
      { label: 'Drawer', sound: 'Drawer', conf: 0.84 },
    ],
  },
  {
    title: 'Movement & Voice',
    subtitle: 'Presence & transitions',
    items: [
      { label: 'Speech', sound: 'Speech', conf: 0.86 },
      { label: 'Footsteps', sound: 'Footsteps', conf: 0.79 },
      { label: 'Door knock', sound: 'Knock', conf: 0.88 },
      { label: 'Keys jingling', sound: 'Keys jingling', conf: 0.94 },
    ],
  },
];

// Minimal crisp SVG icons matching the dark navy/charcoal theme
function MicIcon({ color = 'currentColor', size = 18 }: { color?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" x2="12" y1="19" y2="22" />
    </svg>
  );
}

function BellAlertIcon({ color = 'currentColor', size = 18 }: { color?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

function WaveIcon({ color = 'currentColor', size = 18 }: { color?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2 12h2" />
      <path d="M6 8v8" />
      <path d="M10 5v14" />
      <path d="M14 9v6" />
      <path d="M18 7v10" />
      <path d="M22 12h-2" />
    </svg>
  );
}

function ActivityIcon({ color = 'currentColor', size = 18 }: { color?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}

function RoomPinIcon({ color = 'currentColor', size = 18 }: { color?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0Z" />
      <circle cx="12" cy="10" r="3" />
    </svg>
  );
}

function SlidersPlayIcon({ color = 'currentColor', size = 18 }: { color?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="6 3 20 12 6 21 6 3" />
    </svg>
  );
}

function CheckIcon({ color = 'currentColor', size = 14 }: { color?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="20 6 9 17 4 12" />
    </svg>
  );
}

function LockIcon({ color = 'currentColor', size = 14 }: { color?: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect width="18" height="11" x="3" y="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}

export default function OverviewDashboard({
  room,
  rooms,
  onRoomChange,
  isListening,
  audioLevel,
  micError,
  aiStatus,
  onStartListening,
  onStopListening,
  stats,
  unackAlertCount,
  alerts,
  recentEvents,
  activities,
  barChartData,
  maxBarCount,
  simulatorOpen,
  onToggleSimulator,
  onTriggerSimulatedSound,
  onAcknowledgeAlert,
  onAcknowledgeAllAlerts,
  onTestChime,
  onNavigateTab,
  formatTime,
  formatDateTime,
}: OverviewDashboardProps) {
  // Prioritize unacknowledged alerts first, keeping dashboard scannable
  const displayedAlerts = [...alerts]
    .sort((a, b) => a.acknowledged - b.acknowledged)
    .slice(0, 5);

  const displayedEvents = recentEvents.slice(0, 6);
  const displayedActivities = activities.slice(0, 4);

  const severityStyle = (severity: Alert['severity']) => {
    switch (severity) {
      case 'Critical':
        return { color: '#f85149', bg: 'rgba(218, 54, 51, 0.14)', border: 'rgba(248, 81, 73, 0.45)' };
      case 'High':
        return { color: '#e3b341', bg: 'rgba(227, 179, 65, 0.12)', border: 'rgba(227, 179, 65, 0.4)' };
      case 'Medium':
        return { color: '#58a6ff', bg: 'rgba(88, 166, 255, 0.12)', border: 'rgba(88, 166, 255, 0.35)' };
      default:
        return { color: '#8b949e', bg: '#21262d', border: '#30363d' };
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '20px' }}>
      <style>{`
        .et-btn {
          transition: background-color 0.15s ease, border-color 0.15s ease, opacity 0.15s ease;
        }
        .et-btn:hover {
          filter: brightness(1.1);
        }
        .et-btn:focus-visible,
        .et-select:focus-visible {
          outline: 2px solid #58a6ff;
          outline-offset: 2px;
        }
        .et-card-interactive {
          transition: border-color 0.15s ease, background-color 0.15s ease;
        }
        .et-card-interactive:hover {
          border-color: #58a6ff !important;
        }
        .et-kpi-grid {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: 16px;
        }
        .et-two-col {
          display: grid;
          grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
          gap: 20px;
          align-items: start;
        }
        .et-insights-grid {
          display: grid;
          grid-template-columns: minmax(0, 1.65fr) minmax(0, 1fr);
          gap: 20px;
          align-items: start;
        }
        .et-sim-grid {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 16px;
        }
        .et-monitor-layout {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 24px;
          flex-wrap: wrap;
        }
        @media (max-width: 1180px) {
          .et-kpi-grid {
            grid-template-columns: repeat(2, minmax(0, 1fr));
          }
          .et-two-col,
          .et-insights-grid,
          .et-sim-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>

      {/* ── 2. MONITORING CARD ──────────────────────────────────────────────── */}
      <section
        aria-label="Live Audio Monitoring Controls"
        style={{
          backgroundColor: '#161b22',
          border: isListening ? '1px solid #238636' : '1px solid #30363d',
          borderRadius: '10px',
          padding: '20px 24px',
          display: 'flex',
          flexDirection: 'column',
          gap: '16px',
        }}
      >
        <div className="et-monitor-layout">
          {/* Left: Room & Microphone Status */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', flex: '1 1 340px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
              <div
                style={{
                  width: '40px',
                  height: '40px',
                  borderRadius: '8px',
                  backgroundColor: isListening ? 'rgba(63, 185, 80, 0.14)' : '#21262d',
                  border: `1px solid ${isListening ? 'rgba(63, 185, 80, 0.4)' : '#30363d'}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: isListening ? '#3fb950' : '#8b949e',
                  flexShrink: 0,
                }}
              >
                <MicIcon size={20} />
              </div>
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                  <h2 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600, color: '#ffffff' }}>
                    Ambient Microphone
                  </h2>
                  <span
                    style={{
                      fontSize: '0.78rem',
                      fontWeight: 600,
                      color: isListening ? '#3fb950' : '#8b949e',
                    }}
                  >
                    {isListening ? '● Active · Listening locally' : '○ Standby · Paused'}
                  </span>
                </div>
                <div style={{ fontSize: '0.82rem', color: '#8b949e', marginTop: '2px', display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                  <span>Captures 16 kHz audio locally</span>
                  <span aria-hidden="true">·</span>
                  <span>
                    Engine:{' '}
                    <strong style={{ color: '#c9d1d9', fontWeight: 500 }}>
                      {aiStatus.ready && aiStatus.is_neural_network ? 'YAMNet Ready' : 'Acoustic Classifier Ready'}
                    </strong>
                  </span>
                </div>
              </div>
            </div>

            {/* Room selector + Privacy assurance */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', flexWrap: 'wrap', marginTop: '2px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                <label
                  htmlFor="dashboard-room-select"
                  style={{ fontSize: '0.8rem', fontWeight: 500, color: '#8b949e', whiteSpace: 'nowrap' }}
                >
                  Selected Room
                </label>
                <select
                  id="dashboard-room-select"
                  className="et-select"
                  value={room}
                  onChange={(e) => onRoomChange(e.target.value)}
                  style={{
                    backgroundColor: '#21262d',
                    color: '#e6edf3',
                    border: '1px solid #30363d',
                    borderRadius: '6px',
                    padding: '6px 10px',
                    fontSize: '0.84rem',
                    fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  {rooms.map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
              </div>

              <span style={{ fontSize: '0.78rem', color: '#8b949e', display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
                <LockIcon size={13} color="#8b949e" />
                Zero raw audio stored or uploaded
              </span>
            </div>
          </div>

          {/* Right: Audio Activity Meter & Primary Start/Stop CTA */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '20px', flex: '1 1 320px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            {/* Audio Activity Indicator */}
            <div style={{ minWidth: '190px', flex: '1 1 190px', maxWidth: '260px' }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  fontSize: '0.78rem',
                  color: '#8b949e',
                  marginBottom: '6px',
                }}
              >
                <span>Audio Activity</span>
                <span style={{ fontVariantNumeric: 'tabular-nums', fontWeight: 600, color: isListening ? '#e6edf3' : '#8b949e' }}>
                  {isListening ? `${audioLevel}%` : 'Idle'}
                </span>
              </div>
              <div
                role="progressbar"
                aria-valuenow={isListening ? audioLevel : 0}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Microphone audio activity level"
                style={{
                  height: '12px',
                  backgroundColor: '#0d1117',
                  borderRadius: '6px',
                  border: '1px solid #30363d',
                  display: 'flex',
                  padding: '2px',
                  gap: '3px',
                }}
              >
                {[10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((step) => {
                  const active = isListening && audioLevel >= step;
                  const barColor = step <= 50 ? '#3fb950' : step <= 80 ? '#e3b341' : '#f85149';
                  return (
                    <div
                      key={step}
                      style={{
                        flex: 1,
                        backgroundColor: active ? barColor : '#21262d',
                        borderRadius: '2px',
                        transition: 'background-color 0.1s ease',
                      }}
                    />
                  );
                })}
              </div>
            </div>

            {/* Start / Stop Listening Button */}
            {isListening ? (
              <button
                type="button"
                className="et-btn"
                onClick={onStopListening}
                style={{
                  backgroundColor: '#21262d',
                  color: '#f85149',
                  border: '1px solid #da3633',
                  borderRadius: '8px',
                  fontWeight: 600,
                  padding: '11px 20px',
                  fontSize: '0.9rem',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '8px',
                  whiteSpace: 'nowrap',
                  minHeight: '44px',
                }}
              >
                <span
                  aria-hidden="true"
                  style={{ width: '10px', height: '10px', borderRadius: '2px', backgroundColor: '#f85149', display: 'inline-block' }}
                />
                Stop Listening
              </button>
            ) : (
              <button
                type="button"
                className="et-btn"
                onClick={onStartListening}
                style={{
                  backgroundColor: '#238636',
                  color: '#ffffff',
                  border: '1px solid #2ea043',
                  borderRadius: '8px',
                  fontWeight: 600,
                  padding: '11px 22px',
                  fontSize: '0.9rem',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: '8px',
                  whiteSpace: 'nowrap',
                  minHeight: '44px',
                }}
              >
                <SlidersPlayIcon size={15} color="#ffffff" />
                Start Listening
              </button>
            )}
          </div>
        </div>

        {micError && (
          <div
            role="alert"
            style={{
              padding: '10px 14px',
              backgroundColor: 'rgba(227, 179, 65, 0.1)',
              border: '1px solid #9e6a03',
              borderRadius: '8px',
              fontSize: '0.82rem',
              color: '#e3b341',
              lineHeight: 1.45,
            }}
          >
            {micError}
          </div>
        )}
      </section>

      {/* ── 3. OVERVIEW CARDS ───────────────────────────────────────────────── */}
      <section aria-label="Dashboard Overview Summary" className="et-kpi-grid">
        {/* Card 1: Today's Sound Events */}
        <div
          style={{
            backgroundColor: '#161b22',
            border: '1px solid #30363d',
            borderRadius: '10px',
            padding: '16px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#8b949e', fontSize: '0.8rem', fontWeight: 500 }}>
              Today&apos;s Sound Events
            </span>
            <span style={{ color: '#58a6ff' }}>
              <WaveIcon size={17} />
            </span>
          </div>
          <div style={{ color: '#ffffff', fontSize: '1.75rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>
            {stats.today}
          </div>
          <div style={{ color: '#8b949e', fontSize: '0.78rem', fontVariantNumeric: 'tabular-nums' }}>
            {stats.total} total recorded events
          </div>
        </div>

        {/* Card 2: Active Alerts */}
        <button
          type="button"
          className="et-card-interactive"
          onClick={() => onNavigateTab('alerts')}
          style={{
            backgroundColor: '#161b22',
            border: unackAlertCount > 0 ? '1px solid #f85149' : '1px solid #30363d',
            borderRadius: '10px',
            padding: '16px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            textAlign: 'left',
            cursor: 'pointer',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
            <span style={{ color: '#8b949e', fontSize: '0.8rem', fontWeight: 500 }}>
              Active Alerts
            </span>
            <span style={{ color: unackAlertCount > 0 ? '#f85149' : '#3fb950' }}>
              <BellAlertIcon size={17} />
            </span>
          </div>
          <div
            style={{
              color: unackAlertCount > 0 ? '#f85149' : '#3fb950',
              fontSize: '1.75rem',
              fontWeight: 700,
              fontVariantNumeric: 'tabular-nums',
              lineHeight: 1.1,
            }}
          >
            {unackAlertCount}
          </div>
          <div style={{ color: unackAlertCount > 0 ? '#ff7b72' : '#3fb950', fontSize: '0.78rem', fontWeight: 500 }}>
            {unackAlertCount > 0 ? 'Pending review · Open Alerts →' : 'All quiet and safe'}
          </div>
        </button>

        {/* Card 3: Daily Routines */}
        <button
          type="button"
          className="et-card-interactive"
          onClick={() => onNavigateTab('activities')}
          style={{
            backgroundColor: '#161b22',
            border: '1px solid #30363d',
            borderRadius: '10px',
            padding: '16px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
            textAlign: 'left',
            cursor: 'pointer',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
            <span style={{ color: '#8b949e', fontSize: '0.8rem', fontWeight: 500 }}>
              Daily Routines
            </span>
            <span style={{ color: '#3fb950' }}>
              <ActivityIcon size={17} />
            </span>
          </div>
          <div style={{ color: '#ffffff', fontSize: '1.75rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>
            {activities.length}
          </div>
          <div style={{ color: '#58a6ff', fontSize: '0.78rem', fontWeight: 500 }}>
            Inferred activity patterns →
          </div>
        </button>

        {/* Card 4: Monitored Room */}
        <div
          style={{
            backgroundColor: '#161b22',
            border: '1px solid #30363d',
            borderRadius: '10px',
            padding: '16px 18px',
            display: 'flex',
            flexDirection: 'column',
            gap: '8px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ color: '#8b949e', fontSize: '0.8rem', fontWeight: 500 }}>
              Monitored Room
            </span>
            <span style={{ color: isListening ? '#3fb950' : '#8b949e' }}>
              <RoomPinIcon size={17} />
            </span>
          </div>
          <div
            style={{
              color: '#ffffff',
              fontSize: '1.35rem',
              fontWeight: 700,
              lineHeight: 1.35,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {room}
          </div>
          <div style={{ color: isListening ? '#3fb950' : '#8b949e', fontSize: '0.78rem', fontWeight: 500 }}>
            {isListening ? '● Live audio stream' : '○ Monitoring standby'}
          </div>
        </div>
      </section>

      {/* ── 4 & 5. CAREGIVER ALERTS & RECENT SOUND EVENTS ───────────────────── */}
      <div className="et-two-col">
        {/* 4. Caregiver Alerts */}
        <section
          id="alerts-section"
          aria-label="Caregiver Alerts"
          style={{
            backgroundColor: '#161b22',
            border: '1px solid #30363d',
            borderRadius: '10px',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600, color: '#ffffff', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <BellAlertIcon size={17} color={unackAlertCount > 0 ? '#f85149' : '#8b949e'} />
                Caregiver Alerts
              </h3>
              <div style={{ fontSize: '0.78rem', color: '#8b949e', marginTop: '2px' }}>
                {unackAlertCount > 0
                  ? `${unackAlertCount} unacknowledged alert${unackAlertCount === 1 ? '' : 's'} awaiting review`
                  : 'No urgent unacknowledged alerts'}
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="et-btn"
                onClick={onTestChime}
                style={{
                  backgroundColor: '#21262d',
                  color: '#c9d1d9',
                  border: '1px solid #30363d',
                  borderRadius: '6px',
                  padding: '6px 10px',
                  fontSize: '0.76rem',
                  fontWeight: 500,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                Test Chime
              </button>
              {unackAlertCount > 0 && (
                <button
                  type="button"
                  className="et-btn"
                  onClick={onAcknowledgeAllAlerts}
                  style={{
                    backgroundColor: '#238636',
                    color: '#ffffff',
                    border: '1px solid #2ea043',
                    borderRadius: '6px',
                    padding: '6px 10px',
                    fontSize: '0.76rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  Acknowledge All
                </button>
              )}
              <button
                type="button"
                className="et-btn"
                onClick={() => onNavigateTab('alerts')}
                style={{
                  backgroundColor: 'transparent',
                  color: '#58a6ff',
                  border: 'none',
                  padding: '4px 2px',
                  fontSize: '0.78rem',
                  fontWeight: 500,
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                All Alerts →
              </button>
            </div>
          </div>

          {displayedAlerts.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {displayedAlerts.map((al) => {
                const sev = severityStyle(al.severity);
                const isPending = al.acknowledged === 0;
                return (
                  <div
                    key={al.id}
                    id={`alert-row-${al.id}`}
                    style={{
                      backgroundColor: isPending ? 'rgba(248, 81, 73, 0.06)' : '#0d1117',
                      border: `1px solid ${isPending ? 'rgba(248, 81, 73, 0.35)' : '#21262d'}`,
                      borderRadius: '8px',
                      padding: '12px 14px',
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      gap: '12px',
                      flexWrap: 'wrap',
                    }}
                  >
                    <div style={{ minWidth: '200px', flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '0.9rem', fontWeight: 600, color: '#ffffff' }}>
                          {al.alert_type}
                        </span>
                        <span
                          style={{
                            fontSize: '0.7rem',
                            fontWeight: 700,
                            color: sev.color,
                            backgroundColor: sev.bg,
                            border: `1px solid ${sev.border}`,
                            borderRadius: '4px',
                            padding: '1px 6px',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          {al.severity}
                        </span>
                      </div>
                      <div style={{ fontSize: '0.78rem', color: '#8b949e', marginTop: '4px', fontVariantNumeric: 'tabular-nums' }}>
                        <span>{al.room || 'Unspecified'}</span>
                        <span aria-hidden="true"> · </span>
                        <span>{formatDateTime(al.timestamp)}</span>
                        <span aria-hidden="true"> · </span>
                        <span>{al.source === 'microphone' ? 'Microphone' : 'Simulated'}</span>
                      </div>
                    </div>

                    {isPending ? (
                      <button
                        type="button"
                        className="et-btn"
                        onClick={() => onAcknowledgeAlert(al.id)}
                        style={{
                          backgroundColor: '#21262d',
                          color: '#e6edf3',
                          border: '1px solid #30363d',
                          borderRadius: '6px',
                          padding: '7px 12px',
                          fontSize: '0.78rem',
                          fontWeight: 600,
                          cursor: 'pointer',
                          whiteSpace: 'nowrap',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '5px',
                        }}
                      >
                        <CheckIcon size={13} color="#3fb950" />
                        Acknowledge
                      </button>
                    ) : (
                      <span
                        style={{
                          fontSize: '0.76rem',
                          color: '#3fb950',
                          fontWeight: 500,
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: '4px',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        <CheckIcon size={13} color="#3fb950" />
                        Acknowledged
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <div
              style={{
                backgroundColor: '#0d1117',
                border: '1px dashed #30363d',
                borderRadius: '8px',
                padding: '28px 18px',
                textAlign: 'center',
                color: '#8b949e',
                fontSize: '0.84rem',
                lineHeight: 1.5,
              }}
            >
              No caregiver alerts recorded. Critical sounds such as smoke alarms, glass breaking, or loud impacts will appear here immediately.
            </div>
          )}
        </section>

        {/* 5. Recent Sound Events */}
        <section
          aria-label="Recent Sound Events"
          style={{
            backgroundColor: '#161b22',
            border: '1px solid #30363d',
            borderRadius: '10px',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600, color: '#ffffff', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <WaveIcon size={17} color="#58a6ff" />
                Recent Sound Events
              </h3>
              <div style={{ fontSize: '0.78rem', color: '#8b949e', marginTop: '2px' }}>
                Auto-refreshes every 3s while listening
              </div>
            </div>
            <button
              type="button"
              className="et-btn"
              onClick={() => onNavigateTab('history')}
              style={{
                backgroundColor: 'transparent',
                color: '#58a6ff',
                border: 'none',
                padding: '4px 2px',
                fontSize: '0.78rem',
                fontWeight: 500,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Full Timeline →
            </button>
          </div>

          {displayedEvents.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {displayedEvents.map((ev, index) => (
                <div
                  key={ev.id}
                  style={{
                    padding: '11px 4px',
                    borderBottom: index === displayedEvents.length - 1 ? 'none' : '1px solid #21262d',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    gap: '12px',
                  }}
                >
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
                      <span style={{ fontSize: '0.9rem', fontWeight: 600, color: '#ffffff' }}>
                        {ev.sound_class}
                      </span>
                      {ev.duration > 1 && (
                        <span style={{ fontSize: '0.74rem', color: '#8b949e', fontVariantNumeric: 'tabular-nums' }}>
                          {ev.duration}s
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '0.78rem', color: '#8b949e', marginTop: '3px', fontVariantNumeric: 'tabular-nums' }}>
                      <span>{ev.room}</span>
                      <span aria-hidden="true"> · </span>
                      <span>{formatTime(ev.timestamp)}</span>
                      <span aria-hidden="true"> · </span>
                      <span style={{ color: ev.source === 'microphone' ? '#3fb950' : '#8b949e' }}>
                        {ev.source === 'microphone' ? 'Microphone' : 'Simulator'}
                      </span>
                    </div>
                  </div>

                  <div
                    style={{
                      fontSize: '0.86rem',
                      fontWeight: 600,
                      color: '#58a6ff',
                      fontVariantNumeric: 'tabular-nums',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {Math.round(ev.confidence * 100)}%
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div
              style={{
                backgroundColor: '#0d1117',
                border: '1px dashed #30363d',
                borderRadius: '8px',
                padding: '28px 18px',
                textAlign: 'center',
                color: '#8b949e',
                fontSize: '0.84rem',
                lineHeight: 1.5,
              }}
            >
              {isListening
                ? 'Listening for ambient sounds in real time. Detected events will appear here automatically.'
                : 'No sound events recorded yet. Click Start Listening above or test a sound in the Sound Simulator.'}
            </div>
          )}
        </section>
      </div>

      {/* ── 7. DAILY ACTIVITY INSIGHTS & FREQUENCY SUMMARY ──────────────────── */}
      <div className="et-insights-grid">
        {/* Daily Activity Insights */}
        <section
          aria-label="Daily Activity Insights"
          style={{
            backgroundColor: '#161b22',
            border: '1px solid #30363d',
            borderRadius: '10px',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600, color: '#ffffff', display: 'flex', alignItems: 'center', gap: '8px' }}>
                <ActivityIcon size={17} color="#3fb950" />
                Daily Activity Insights
              </h3>
              <div style={{ fontSize: '0.78rem', color: '#8b949e', marginTop: '2px' }}>
                Routines automatically inferred from related room sounds
              </div>
            </div>
            <button
              type="button"
              className="et-btn"
              onClick={() => onNavigateTab('activities')}
              style={{
                backgroundColor: 'transparent',
                color: '#58a6ff',
                border: 'none',
                padding: '4px 2px',
                fontSize: '0.78rem',
                fontWeight: 500,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              View All ({activities.length}) →
            </button>
          </div>

          {displayedActivities.length > 0 ? (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '12px' }}>
              {displayedActivities.map((act) => {
                let supportingCount = 0;
                try {
                  supportingCount = JSON.parse(act.related_event_ids || '[]').length;
                } catch {
                  supportingCount = 0;
                }
                return (
                  <div
                    key={act.id}
                    style={{
                      backgroundColor: '#0d1117',
                      border: '1px solid #21262d',
                      borderRadius: '8px',
                      padding: '14px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: '6px',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
                      <span style={{ fontSize: '0.9rem', fontWeight: 600, color: '#ffffff' }}>
                        {act.activity_type}
                      </span>
                      <span style={{ fontSize: '0.76rem', color: '#58a6ff', fontWeight: 500, whiteSpace: 'nowrap' }}>
                        {act.room}
                      </span>
                    </div>
                    <div style={{ fontSize: '0.8rem', color: '#c9d1d9', lineHeight: 1.45 }}>
                      {act.description}
                    </div>
                    <div style={{ fontSize: '0.75rem', color: '#8b949e', marginTop: 'auto', paddingTop: '4px', fontVariantNumeric: 'tabular-nums' }}>
                      {formatTime(act.start_time)} – {formatTime(act.end_time)}
                      {supportingCount > 0 ? ` · ${supportingCount} supporting sound${supportingCount === 1 ? '' : 's'}` : ''}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div
              style={{
                backgroundColor: '#0d1117',
                border: '1px dashed #30363d',
                borderRadius: '8px',
                padding: '24px 18px',
                textAlign: 'center',
                color: '#8b949e',
                fontSize: '0.84rem',
                lineHeight: 1.5,
              }}
            >
              No daily routines inferred yet. As sequences of related sounds occur in a room (such as water tap and dishes), activity insights will appear here.
            </div>
          )}
        </section>

        {/* Top Detected Sounds Breakdown */}
        <section
          aria-label="Top Detected Sounds"
          style={{
            backgroundColor: '#161b22',
            border: '1px solid #30363d',
            borderRadius: '10px',
            padding: '20px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
            <div>
              <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600, color: '#ffffff' }}>
                Sound Frequency
              </h3>
              <div style={{ fontSize: '0.78rem', color: '#8b949e', marginTop: '2px' }}>
                Most frequent detections
              </div>
            </div>
            <button
              type="button"
              className="et-btn"
              onClick={() => onNavigateTab('analytics')}
              style={{
                backgroundColor: 'transparent',
                color: '#58a6ff',
                border: 'none',
                padding: '4px 2px',
                fontSize: '0.78rem',
                fontWeight: 500,
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              Patterns →
            </button>
          </div>

          {barChartData.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {barChartData.slice(0, 6).map((item) => {
                const pct = Math.max(8, Math.round((item.count / maxBarCount) * 100));
                return (
                  <div key={item.sound}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem', marginBottom: '4px' }}>
                      <span style={{ color: '#e6edf3', fontWeight: 500 }}>{item.sound}</span>
                      <span style={{ color: '#58a6ff', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                        {item.count}
                      </span>
                    </div>
                    <div style={{ height: '7px', backgroundColor: '#21262d', borderRadius: '4px', overflow: 'hidden' }}>
                      <div style={{ width: `${pct}%`, height: '100%', backgroundColor: '#58a6ff', borderRadius: '4px' }} />
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div style={{ fontSize: '0.82rem', color: '#8b949e', lineHeight: 1.5 }}>
              Sound frequency bars will appear here as events are recorded.
            </div>
          )}
        </section>
      </div>

      {/* ── 6. SOUND SIMULATOR ──────────────────────────────────────────────── */}
      <section
        aria-label="Sound Simulator"
        style={{
          backgroundColor: '#161b22',
          border: '1px solid #30363d',
          borderRadius: '10px',
          padding: '20px',
          display: 'flex',
          flexDirection: 'column',
          gap: simulatorOpen ? '16px' : '0px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <div>
            <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600, color: '#ffffff' }}>
              Sound Simulator
            </h3>
            <div style={{ fontSize: '0.78rem', color: '#8b949e', marginTop: '2px' }}>
              Test detections and caregiver alerts in <strong style={{ color: '#e6edf3', fontWeight: 500 }}>{room}</strong> · Tagged as Simulated
            </div>
          </div>

          <button
            type="button"
            className="et-btn"
            onClick={onToggleSimulator}
            style={{
              backgroundColor: '#21262d',
              color: '#c9d1d9',
              border: '1px solid #30363d',
              borderRadius: '6px',
              padding: '6px 12px',
              fontSize: '0.78rem',
              fontWeight: 500,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
            }}
          >
            {simulatorOpen ? 'Hide Simulator' : 'Show Simulator'}
          </button>
        </div>

        {simulatorOpen && (
          <div className="et-sim-grid">
            {SIMULATOR_CATEGORIES.map((category) => (
              <div
                key={category.title}
                style={{
                  backgroundColor: '#0d1117',
                  border: '1px solid #21262d',
                  borderRadius: '8px',
                  padding: '14px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '10px',
                }}
              >
                <div>
                  <div style={{ fontSize: '0.84rem', fontWeight: 600, color: '#ffffff' }}>
                    {category.title}
                  </div>
                  <div style={{ fontSize: '0.74rem', color: '#8b949e', marginTop: '1px' }}>
                    {category.subtitle}
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}>
                  {category.items.map((item) => {
                    const isAlert = Boolean(item.alertTag);
                    return (
                      <button
                        key={item.label}
                        type="button"
                        className="et-btn"
                        onClick={() => onTriggerSimulatedSound(item.sound, item.conf)}
                        style={{
                          backgroundColor: isAlert ? 'rgba(218, 54, 51, 0.1)' : '#21262d',
                          color: isAlert ? '#ff7b72' : '#e6edf3',
                          border: isAlert ? '1px solid rgba(248, 81, 73, 0.45)' : '1px solid #30363d',
                          borderRadius: '6px',
                          padding: '9px 12px',
                          fontSize: '0.82rem',
                          fontWeight: 500,
                          textAlign: 'left',
                          cursor: 'pointer',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                          gap: '8px',
                          width: '100%',
                        }}
                      >
                        <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                          {item.label}
                        </span>
                        {item.alertTag ? (
                          <span
                            style={{
                              fontSize: '0.7rem',
                              fontWeight: 700,
                              color: item.alertTag === 'Critical' ? '#f85149' : '#e3b341',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {item.alertTag}
                          </span>
                        ) : (
                          <span style={{ fontSize: '0.74rem', color: '#8b949e', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                            {Math.round(item.conf * 100)}%
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
