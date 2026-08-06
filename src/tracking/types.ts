// ─── HRMS tracking types ─────────────────────────────────────────────────────
export interface TrackingPoint {
  latitude: number;
  longitude: number;
  accuracy: number;
  captured_at: string; // ISO UTC — GPS measurement time (position.timestamp)
}

export type TrackingStatus =
  | 'tracking_started'
  | 'tracking_stopped'
  | 'tracking_resumed'        // auto-resume after backend 24h cap (silent renew)
  | 'permission_denied'
  | 'notification_permission_denied' // POST_NOTIFICATIONS denied — tracking works but no status-bar indicator
  | 'session_expired'         // emitted only when auto-resume gives up
  | 'auth_expired'
  | 'start_failed';

export interface TrackingActiveSession {
  employeeId: number;
  organizationId: number;
  sessionId: string;
}
