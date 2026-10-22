// Network monitoring types for Omnidex (Svelte version)

export interface NetworkState {
  isOnline: boolean;
  orbitalApiStatus: 'healthy' | 'degraded' | 'unreachable';
  lastHealthCheck: Date | null;
  failedRequests: QueuedRequest[];
}

export interface QueuedRequest {
  id: string;
  endpoint: string;
  payload: unknown;
  retryCount: number;
  maxRetries: number;
  queuedAt: Date;
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unreachable';
  response_time_ms?: number;
  last_successful_request?: string;
}
