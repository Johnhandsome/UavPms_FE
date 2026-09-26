import { Injectable, NgZone, inject } from '@angular/core';
import { HubConnection, HubConnectionBuilder, HubConnectionState, LogLevel } from '@microsoft/signalr';
import { Subject } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { Auth } from '../../../core/auth/auth';
import { Mission, MissionCommunicationLog } from '../../../models/missions.models';
import { AppNotification } from '../../../models/notification.models';
import { normalizeNotification } from './notifications-api';

export type AiAnalysisRealtimeStatus = 'Pending' | 'Completed' | 'Failed' | string;

export interface AiAnalysisStatusChangedEvent {
  readonly requestId: string;
  readonly batchId: string;
  readonly missionId: string;
  readonly mediaId: string;
  readonly mediaType: string;
  readonly status: AiAnalysisRealtimeStatus;
  readonly savedDetections: number;
  readonly createdAlerts: number;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly createdAt: string;
  readonly completedAt: string;
}

export type MissionLifecycleEventType =
  | 'CONFIRMED'
  | 'DISPATCHED'
  | 'ASSIGNED'
  | 'CREATED'
  | 'SUSPENDED'
  | 'POSTPONED'
  | 'REASSIGNED'
  | 'RESUMED'
  | 'CANCELLED'
  | 'REMINDER'
  | 'COMMUNICATION'
  | 'STARTED'
  | 'COMPLETED'
  | 'OVERDUE';

export interface MissionLifecycleRealtimeEvent {
  readonly missionId: string;
  readonly type: MissionLifecycleEventType;
  readonly status?: string;
  readonly assignmentId?: string;
  readonly confirmationDeadline?: string;
  readonly managerInstructions?: string;
  readonly mission?: Partial<Mission>;
  readonly actorId?: string;
  readonly actorName?: string;
  readonly actorRole?: 'MANAGER' | 'INSPECTOR' | 'ANALYST' | 'TECHNICIAN' | 'SYSTEM' | string;
  readonly allConfirmed?: boolean;
  readonly confirmedCount?: number;
  readonly totalRequiredCount?: number;
  readonly pendingRoles?: readonly string[];
  readonly reason?: string;
  readonly message?: string;
  readonly log?: MissionCommunicationLog;
  readonly timestamp: string;
}

const MF02_BROADCAST_CHANNEL = 'uavpms_mf02_realtime_bus';

@Injectable({
  providedIn: 'root',
})
export class NotificationsRealtime {
  private readonly auth = inject(Auth);
  private readonly zone = inject(NgZone);
  private readonly notificationSubject = new Subject<AppNotification>();
  private readonly aiAnalysisStatusSubject = new Subject<AiAnalysisStatusChangedEvent>();
  private readonly missionEventsSubject = new Subject<MissionLifecycleRealtimeEvent>();
  private readonly statusSubject = new Subject<'connected' | 'disconnected' | 'reconnecting'>();

  private connection: HubConnection | null = null;
  private starting: Promise<void> | null = null;
  private broadcastChannel: BroadcastChannel | null = null;
  private readonly activeMissionGroups = new Set<string>();

  readonly notifications$ = this.notificationSubject.asObservable();
  readonly aiAnalysisStatus$ = this.aiAnalysisStatusSubject.asObservable();
  readonly missionEvents$ = this.missionEventsSubject.asObservable();
  readonly status$ = this.statusSubject.asObservable();

  constructor() {
    this.initBroadcastChannel();
  }

  private initBroadcastChannel(): void {
    if (typeof window === 'undefined' || !('BroadcastChannel' in window)) return;
    try {
      this.broadcastChannel = new BroadcastChannel(MF02_BROADCAST_CHANNEL);
      this.broadcastChannel.onmessage = (event: MessageEvent<MissionLifecycleRealtimeEvent>) => {
        if (event.data && event.data.missionId && event.data.type) {
          this.zone.run(() => this.missionEventsSubject.next(event.data));
        }
      };
    } catch {
      // Ignore broadcast channel init failure
    }
  }

  joinMission(missionId: string): void {
    if (!missionId) return;
    this.activeMissionGroups.add(missionId);
    if (this.connection && this.connection.state === HubConnectionState.Connected) {
      this.connection.invoke('JoinMissionGroup', missionId).catch(() => {});
      this.connection.invoke('JoinMission', missionId).catch(() => {});
      this.connection.invoke('JoinGroup', `mission_${missionId}`).catch(() => {});
      this.connection.invoke('JoinGroup', missionId).catch(() => {});
    }
  }

  leaveMission(missionId: string): void {
    if (!missionId) return;
    this.activeMissionGroups.delete(missionId);
    if (this.connection && this.connection.state === HubConnectionState.Connected) {
      this.connection.invoke('LeaveMissionGroup', missionId).catch(() => {});
      this.connection.invoke('LeaveMission', missionId).catch(() => {});
      this.connection.invoke('LeaveGroup', `mission_${missionId}`).catch(() => {});
      this.connection.invoke('LeaveGroup', missionId).catch(() => {});
    }
  }

  broadcastMissionEvent(event: MissionLifecycleRealtimeEvent): void {
    // 1. Emit locally on current tab
    this.zone.run(() => this.missionEventsSubject.next(event));

    // 2. Broadcast across other tabs on same device (instant sync)
    try {
      this.broadcastChannel?.postMessage(event);
    } catch {
      // Ignore postMessage failure
    }

    // 3. Emit via SignalR Hub WebSocket to server and other network clients
    if (this.connection && this.connection.state === HubConnectionState.Connected) {
      this.connection.send('SendMissionEvent', event).catch(() => {});
      this.connection.send('BroadcastMissionLifecycle', event).catch(() => {});
      this.connection.send('BroadcastEvent', event).catch(() => {});
    }
  }

  connect(): void {
    if (this.connection?.state === HubConnectionState.Connected || this.starting) return;
    this.connection = this.buildConnection();
    this.registerHandlers(this.connection);
    this.starting = this.connection
      .start()
      .then(() => {
        this.zone.run(() => {
          this.statusSubject.next('connected');
          for (const mId of this.activeMissionGroups) {
            this.joinMission(mId);
          }
        });
      })
      .catch(() => this.zone.run(() => this.statusSubject.next('disconnected')))
      .finally(() => {
        this.starting = null;
      });
  }

  disconnect(): void {
    const connection = this.connection;
    this.connection = null;
    this.starting = null;
    void connection?.stop();
    if (this.broadcastChannel) {
      this.broadcastChannel.close();
      this.broadcastChannel = null;
    }
  }

  private buildConnection(): HubConnection {
    return new HubConnectionBuilder()
      .withUrl(environment.notificationsHubUrl, {
        accessTokenFactory: () => this.auth.session()?.tokens.accessToken ?? '',
      })
      .withAutomaticReconnect()
      .configureLogging(LogLevel.Warning)
      .build();
  }

  private registerHandlers(connection: HubConnection): void {
    const receive = (payload: unknown) => this.zone.run(() => this.notificationSubject.next(normalizeNotification(payload)));
    connection.on('ReceiveNotification', receive);
    connection.on('NotificationReceived', receive);
    connection.on('NewNotification', receive);
    connection.on('notification', receive);

    // AI Status handler
    connection.on('AiAnalysisStatusChanged', (payload: unknown) => {
      this.zone.run(() => this.aiAnalysisStatusSubject.next(normalizeAiAnalysisStatus(payload)));
    });

    // MF02 Lifecycle & Dispatch Real-time handlers
    const emitLifecycle = (type: MissionLifecycleEventType, payload: unknown) => {
      const parsed = normalizeMissionLifecycleEvent(type, payload);
      this.zone.run(() => this.missionEventsSubject.next(parsed));
    };

    connection.on('MissionLifecycleEvent', (payload: unknown) => {
      const data = record(payload);
      const type = (stringValue(data['type']).toUpperCase() as MissionLifecycleEventType) || 'CONFIRMED';
      emitLifecycle(type, payload);
    });

    connection.on('ReceiveMissionLifecycleEvent', (payload: unknown) => {
      const data = record(payload);
      const type = (stringValue(data['type']).toUpperCase() as MissionLifecycleEventType) || 'CONFIRMED';
      emitLifecycle(type, payload);
    });

    connection.on('ReceiveMissionLifecycle', (payload: unknown) => {
      const data = record(payload);
      const type = (stringValue(data['type']).toUpperCase() as MissionLifecycleEventType) || 'CONFIRMED';
      emitLifecycle(type, payload);
    });

    connection.on('MissionLifecycleChanged', (payload: unknown) => {
      const data = record(payload);
      const type = (stringValue(data['type']).toUpperCase() as MissionLifecycleEventType) || 'CONFIRMED';
      emitLifecycle(type, payload);
    });

    connection.on('ReceiveMissionEvent', (payload: unknown) => {
      const data = record(payload);
      const type = (stringValue(data['type']).toUpperCase() as MissionLifecycleEventType) || 'CONFIRMED';
      emitLifecycle(type, payload);
    });

    connection.on('MissionConfirmed', (payload: unknown) => emitLifecycle('CONFIRMED', payload));
    connection.on('ReceiveMissionConfirmed', (payload: unknown) => emitLifecycle('CONFIRMED', payload));
    connection.on('MissionAccepted', (payload: unknown) => emitLifecycle('CONFIRMED', payload));
    connection.on('AssignmentAccepted', (payload: unknown) => emitLifecycle('CONFIRMED', payload));
    connection.on('ReceiveAssignmentAccepted', (payload: unknown) => emitLifecycle('CONFIRMED', payload));
    connection.on('MissionDispatched', (payload: unknown) => emitLifecycle('DISPATCHED', payload));
    connection.on('MissionAssigned', (payload: unknown) => emitLifecycle('DISPATCHED', payload));
    connection.on('MissionCreated', (payload: unknown) => emitLifecycle('DISPATCHED', payload));
    connection.on('ReceiveMissionAssigned', (payload: unknown) => emitLifecycle('DISPATCHED', payload));
    connection.on('ReceiveMissionCreated', (payload: unknown) => emitLifecycle('DISPATCHED', payload));
    connection.on('AssignmentCreated', (payload: unknown) => emitLifecycle('DISPATCHED', payload));
    connection.on('MissionSuspended', (payload: unknown) => emitLifecycle('SUSPENDED', payload));
    connection.on('MissionPostponed', (payload: unknown) => emitLifecycle('POSTPONED', payload));
    connection.on('ReceiveMissionPostponed', (payload: unknown) => emitLifecycle('POSTPONED', payload));
    connection.on('AssignmentPostponed', (payload: unknown) => emitLifecycle('POSTPONED', payload));
    connection.on('ReceiveAssignmentPostponed', (payload: unknown) => emitLifecycle('POSTPONED', payload));
    connection.on('MissionResumed', (payload: unknown) => emitLifecycle('RESUMED', payload));
    connection.on('MissionCancelled', (payload: unknown) => emitLifecycle('CANCELLED', payload));
    connection.on('MissionCommunicationReceived', (payload: unknown) => emitLifecycle('COMMUNICATION', payload));
    connection.on('MissionReminderSent', (payload: unknown) => emitLifecycle('REMINDER', payload));
    connection.on('MissionConfirmationOverdue', (payload: unknown) => emitLifecycle('OVERDUE', payload));
    connection.on('MissionUpdated', (payload: unknown) => emitLifecycle('CONFIRMED', payload));
    connection.on('ReceiveMissionUpdated', (payload: unknown) => emitLifecycle('CONFIRMED', payload));

    connection.onreconnecting(() => this.zone.run(() => this.statusSubject.next('reconnecting')));
    connection.onreconnected(() => {
      this.zone.run(() => {
        this.statusSubject.next('connected');
        for (const mId of this.activeMissionGroups) {
          this.joinMission(mId);
        }
      });
    });
    connection.onclose(() => this.zone.run(() => this.statusSubject.next('disconnected')));
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {};

const pick = (source: Record<string, unknown>, ...keys: string[]) =>
  keys.map((key) => source[key]).find((value) => value !== undefined && value !== null);

const stringValue = (value: unknown, fallback = '') =>
  value === undefined || value === null ? fallback : String(value);

const numberValue = (value: unknown) => Number(value ?? 0) || 0;

const normalizeAiAnalysisStatus = (payload: unknown): AiAnalysisStatusChangedEvent => {
  const source = record(payload);
  return {
    requestId: stringValue(pick(source, 'requestId', 'RequestId')),
    batchId: stringValue(pick(source, 'batchId', 'BatchId')),
    missionId: stringValue(pick(source, 'missionId', 'MissionId')),
    mediaId: stringValue(pick(source, 'mediaId', 'MediaId')),
    mediaType: stringValue(pick(source, 'mediaType', 'MediaType')),
    status: stringValue(pick(source, 'status', 'Status')),
    savedDetections: numberValue(pick(source, 'savedDetections', 'SavedDetections')),
    createdAlerts: numberValue(pick(source, 'createdAlerts', 'CreatedAlerts')),
    errorCode: stringValue(pick(source, 'errorCode', 'ErrorCode')),
    errorMessage: stringValue(pick(source, 'errorMessage', 'ErrorMessage')),
    createdAt: stringValue(pick(source, 'createdAt', 'CreatedAt')),
    completedAt: stringValue(pick(source, 'completedAt', 'CompletedAt')),
  };
};

function normalizeMissionLifecycleEvent(
  defaultType: MissionLifecycleEventType,
  payload: unknown
): MissionLifecycleRealtimeEvent {
  const raw = record(payload);
  const source = (raw['data'] && typeof raw['data'] === 'object') ? record(raw['data']) : raw;
  const rawType = stringValue(pick(source, 'type', 'Type', 'eventType', 'EventType')).toUpperCase();
  let type: MissionLifecycleEventType = defaultType;
  if (rawType === 'ASSIGNED' || rawType === 'CREATED' || rawType === 'DISPATCHED' || rawType === 'MISSIONDISPATCHED' || rawType === 'MISSIONASSIGNED' || rawType === 'MISSIONCREATED') {
    type = 'DISPATCHED';
  } else if (rawType) {
    type = rawType as MissionLifecycleEventType;
  }
  const missionId = stringValue(pick(source, 'missionId', 'MissionId', 'id', 'Id', 'entityId', 'EntityId'));
  const actorRole = (stringValue(pick(source, 'actorRole', 'ActorRole', 'senderRole', 'SenderRole')).toUpperCase() as 'MANAGER' | 'INSPECTOR' | 'SYSTEM') || undefined;
  const actorName = stringValue(pick(source, 'actorName', 'ActorName', 'senderName', 'SenderName')) || undefined;
  const reason = stringValue(pick(source, 'reason', 'Reason')) || undefined;
  const message = stringValue(pick(source, 'message', 'Message', 'content', 'Content')) || undefined;
  const timestamp = stringValue(pick(source, 'timestamp', 'Timestamp'), new Date().toISOString());

  let log: MissionCommunicationLog | undefined = undefined;
  if (source['log'] && typeof source['log'] === 'object') {
    const l = record(source['log']);
    log = {
      id: stringValue(l['id'], `log-${Date.now()}`),
      senderId: stringValue(l['senderId'], 'user'),
      senderName: stringValue(l['senderName'], actorName || 'Hệ thống'),
      senderRole: (stringValue(l['senderRole']).toUpperCase() as 'MANAGER' | 'INSPECTOR' | 'SYSTEM') || 'SYSTEM',
      type: (stringValue(l['type']).toUpperCase() as any) || 'DISPATCH',
      content: stringValue(l['content'], message || ''),
      timestamp: stringValue(l['timestamp'], timestamp),
    };
  } else if (message) {
    log = {
      id: `log-${Date.now()}`,
      senderId: stringValue(pick(source, 'actorId', 'ActorId'), 'user'),
      senderName: actorName || (actorRole === 'MANAGER' ? 'Quản lý vận hành' : 'Thanh tra viên'),
      senderRole: actorRole || 'SYSTEM',
      type: type === 'CONFIRMED' ? 'CONFIRM' : type === 'REMINDER' ? 'REMINDER' : type === 'SUSPENDED' ? 'SUSPEND' : type === 'POSTPONED' ? 'POSTPONE' : 'DISPATCH',
      content: message,
      timestamp,
    };
  }

  const assignmentId = stringValue(pick(source, 'assignmentId', 'AssignmentId')) || undefined;
  const allConfirmed = source['allConfirmed'] !== undefined ? Boolean(source['allConfirmed']) : (source['AllConfirmed'] !== undefined ? Boolean(source['AllConfirmed']) : undefined);
  const confirmedCount = source['confirmedCount'] !== undefined ? Number(source['confirmedCount']) : (source['ConfirmedCount'] !== undefined ? Number(source['ConfirmedCount']) : undefined);
  const totalRequiredCount = source['totalRequiredCount'] !== undefined ? Number(source['totalRequiredCount']) : (source['TotalRequiredCount'] !== undefined ? Number(source['TotalRequiredCount']) : undefined);
  const rawPending = pick(source, 'pendingRoles', 'PendingRoles');
  const pendingRoles = Array.isArray(rawPending) ? rawPending.map(String) : undefined;

  return {
    missionId,
    type,
    status: stringValue(pick(source, 'status', 'Status')) || undefined,
    assignmentId,
    confirmationDeadline: stringValue(pick(source, 'confirmationDeadline', 'ConfirmationDeadline')) || undefined,
    managerInstructions: stringValue(pick(source, 'managerInstructions', 'ManagerInstructions')) || undefined,
    actorId: stringValue(pick(source, 'actorId', 'ActorId')) || undefined,
    actorName,
    actorRole,
    allConfirmed,
    confirmedCount,
    totalRequiredCount,
    pendingRoles,
    reason,
    message,
    log,
    timestamp,
    mission: source['mission'] && typeof source['mission'] === 'object' ? (source['mission'] as Partial<Mission>) : undefined,
  };
}
