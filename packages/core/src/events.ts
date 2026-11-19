import type { Notification, Pool, PoolClient } from 'pg';
import type { Principal } from '@siftable/contracts';

export const SIFTABLE_EVENTS_CHANNEL = 'siftable_events';

export interface DomainEventInput {
  operation: string;
  module: string;
  scopeId: string | null;
  ownerId?: string;
}

export interface DomainEvent {
  operation: string;
  module: string;
  ownerId: string | null;
  scopeId: string | null;
  timestamp: string;
}

export function parseDomainEventPayload(raw: string | undefined): DomainEvent | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.operation !== 'string' || !parsed.operation) return null;
    if (typeof parsed.module !== 'string' || !parsed.module) return null;
    const ownerId =
      typeof parsed.ownerId === 'string' && parsed.ownerId.length > 0 ? parsed.ownerId : null;
    const scopeId =
      typeof parsed.scopeId === 'string' && parsed.scopeId.length > 0 ? parsed.scopeId : null;
    const timestamp =
      typeof parsed.timestamp === 'string' && parsed.timestamp.length > 0
        ? parsed.timestamp
        : new Date().toISOString();
    return {
      operation: parsed.operation,
      module: parsed.module,
      ownerId,
      scopeId,
      timestamp,
    };
  } catch {
    return null;
  }
}

export function isDomainEventVisibleToPrincipal(
  event: Pick<DomainEvent, 'ownerId' | 'scopeId'>,
  principal: Pick<Principal, 'ownerId' | 'scopeId'>,
): boolean {
  if (!event.ownerId || event.ownerId !== principal.ownerId) return false;
  return event.scopeId === principal.scopeId;
}

export async function notifyDomainEvent(c: PoolClient, payload: DomainEventInput): Promise<void> {
  const envelope: DomainEvent = {
    operation: payload.operation,
    module: payload.module,
    ownerId: payload.ownerId ?? null,
    scopeId: payload.scopeId,
    timestamp: new Date().toISOString(),
  };
  await c.query('SELECT pg_notify($1, $2)', [SIFTABLE_EVENTS_CHANNEL, JSON.stringify(envelope)]);
}

export async function subscribeDomainEvents(
  pool: Pool,
  onEvent: (event: DomainEvent) => void,
): Promise<() => Promise<void>> {
  let client: PoolClient | null = null;
  let closed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const detachAndRelease = async (target: PoolClient, destroy: boolean) => {
    target.removeListener('notification', handleNotification);
    target.removeListener('error', handleError);
    if (!destroy) {
      try {
        await target.query(`UNLISTEN ${SIFTABLE_EVENTS_CHANNEL}`);
      } catch {
        destroy = true;
      }
    }
    try {
      target.release(destroy);
    } catch {
      // Ignore double-release or pool-closed errors during teardown.
    }
  };

  const handleNotification = (msg: Notification) => {
    if (closed || msg.channel !== SIFTABLE_EVENTS_CHANNEL) return;
    const event = parseDomainEventPayload(msg.payload);
    if (!event) return;
    try {
      onEvent(event);
    } catch {
      // Never let a listener callback crash the PostgreSQL notification loop.
    }
  };

  const scheduleReconnect = () => {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (closed) return;
      void connect().catch(() => {
        scheduleReconnect();
      });
    }, 1000);
    reconnectTimer.unref();
  };

  const handleError = () => {
    const failed = client;
    client = null;
    if (failed) {
      void detachAndRelease(failed, true);
    }
    if (!closed) {
      scheduleReconnect();
    }
  };

  const connect = async (): Promise<void> => {
    const c = await pool.connect();
    if (closed) {
      try {
        c.release();
      } catch {
        // Ignore teardown race.
      }
      return;
    }
    client = c;
    c.on('notification', handleNotification);
    c.on('error', handleError);
    try {
      await c.query(`LISTEN ${SIFTABLE_EVENTS_CHANNEL}`);
    } catch (err) {
      client = null;
      await detachAndRelease(c, true);
      throw err;
    }
  };

  await connect();

  return async () => {
    if (closed) return;
    closed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const active = client;
    client = null;
    if (active) {
      await detachAndRelease(active, false);
    }
  };
}
