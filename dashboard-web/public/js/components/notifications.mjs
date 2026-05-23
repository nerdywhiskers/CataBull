/**
 * notifications.mjs — Browser notification utilities
 *
 * Handles permission requests, sends notifications for:
 * - Scan completion
 * - Interview reminders
 * - New job matches (future)
 */

const NOTIFICATION_KEY = 'catabull-notif-permission';

export async function requestPermission() {
  if (!('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;

  const permission = await Notification.requestPermission();
  localStorage.setItem(NOTIFICATION_KEY, permission);
  return permission === 'granted';
}

export function hasPermission() {
  if (!('Notification' in window)) return false;
  return Notification.permission === 'granted';
}

export function send(title, options = {}) {
  if (!hasPermission()) return false;

  const body = options.body || '';
  const icon = options.icon || '/favicon.ico';
  const tag = options.tag || 'catabull-' + Date.now();
  const requireInteraction = options.requireInteraction || false;

  try {
    const notif = new Notification(title, {
      body,
      icon,
      tag,
      requireInteraction,
      timestamp: Date.now(),
    });

    // Auto-close after 10s unless interacted with
    if (!requireInteraction) {
      setTimeout(() => notif.close(), 10000);
    }

    // Open app when clicked
    notif.onclick = (e) => {
      e.preventDefault();
      window.focus();
      notif.close();
    };

    return true;
  } catch {
    return false;
  }
}

export function notifyScanComplete(count, expired) {
  send('Scan complete', {
    body: `${count} jobs scanned${expired ? ` — ${expired} expired` : ''}`,
    requireInteraction: true,
  });
}

export function notifyInterviewReminder(company, role, days) {
  send('Interview follow-up due', {
    body: `${company} — ${role} (${days}d since application)`,
    requireInteraction: true,
  });
}

export function notifyNewMatch(company, role, score) {
  send('New job match', {
    body: `${company} — ${role} (match: ${score.toFixed(1)})`,
  });
}
