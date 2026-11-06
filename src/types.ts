export interface SoundEvent {
  id: number;
  timestamp: string;
  room: string;
  sound_class: string;
  confidence: number;
  duration: number;
  source: 'microphone' | 'simulator';
  session_id?: string;
}

export interface Activity {
  id: number;
  activity_type: string;
  description: string;
  room: string;
  start_time: string;
  end_time: string;
  confidence: number;
  related_event_ids: string;
}

export interface Alert {
  id: number;
  event_id: number | null;
  alert_type: string;
  severity: 'Low' | 'Medium' | 'High' | 'Critical';
  description: string;
  timestamp: string;
  acknowledged: number;
  acknowledged_at: string | null;
  source: 'microphone' | 'simulator';
}

export interface StatsData {
  total: number;
  today: number;
  thisWeek: number;
  top_sounds: Array<{ sound_class: string; n: number }>;
  roomDistribution?: Array<{ room: string; count: number; percentage: number }>;
  timeOfDay?: {
    morning: number;
    afternoon: number;
    evening: number;
    night: number;
  };
  alertsSummary?: {
    total: number;
    unacknowledged: number;
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  activitiesCount?: number;
}

export interface AiStatus {
  ready: boolean;
  model: string;
  status: 'ready' | 'loading' | 'connecting' | 'fallback' | 'failed' | 'offline';
  is_neural_network?: boolean;
  inference_engine?: string;
  classes_count?: number;
  details?: any;
}
