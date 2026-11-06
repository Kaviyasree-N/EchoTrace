/**
 * src/utils/notificationService.ts
 * Manages Browser Notification API permissions, states, and delivery for caregiver alerts.
 */

import type { Alert, NotificationPermissionState } from '../types';

/**
 * Returns current browser Notification permission status.
 * Returns 'unsupported' if window.Notification is not present in this browser or iframe.
 */
export function getNotificationPermissionStatus(): NotificationPermissionState {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }
  return Notification.permission as NotificationPermissionState;
}

/**
 * Explicitly requests browser Notification permission after user interaction.
 */
export async function requestNotificationPermission(): Promise<NotificationPermissionState> {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return 'unsupported';
  }

  try {
    const result = await Notification.requestPermission();
    return result as NotificationPermissionState;
  } catch (err) {
    console.warn('[EchoTrace] Error requesting notification permission:', err);
    return Notification.permission as NotificationPermissionState;
  }
}

/**
 * Triggers a desktop/browser notification for a caregiver alert.
 * 
 * Formats:
 * - Title: 🚨 [CRITICAL] Smoke Detector Activated in Kitchen (⚡ Simulated)
 * - Body: Description with timestamp and severity
 * - Click handler: Focuses application and executes onNotificationClick callback
 */
export function sendCaregiverNotification(
  alert: Alert,
  onNotificationClick?: (alertId: number) => void
): boolean {
  if (typeof window === 'undefined' || !('Notification' in window)) {
    return false;
  }

  if (Notification.permission !== 'granted') {
    return false;
  }

  try {
    const isSim = alert.source === 'simulator';
    const roomText = alert.room ? ` in ${alert.room}` : '';
    const simTag = isSim ? ' (⚡ Simulated)' : '';
    const title = `🚨 [${alert.severity.toUpperCase()}] ${alert.alert_type}${roomText}${simTag}`;

    let timeStr = alert.timestamp;
    try {
      timeStr = new Date(alert.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    } catch {}

    const body = `${alert.description}\nTime: ${timeStr} · Severity: ${alert.severity}`;

    const notification = new Notification(title, {
      body,
      icon: '/favicon.ico',
      tag: `echotrace-alert-${alert.id}`,
      requireInteraction: alert.severity === 'Critical',
    });

    notification.onclick = () => {
      try {
        window.focus();
      } catch {}

      if (onNotificationClick) {
        onNotificationClick(alert.id);
      }
      notification.close();
    };

    return true;
  } catch (err) {
    console.warn('[EchoTrace] Failed to post browser notification:', err);
    return false;
  }
}
