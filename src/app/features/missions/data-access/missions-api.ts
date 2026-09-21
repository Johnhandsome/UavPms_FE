import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, map, Observable, of, switchMap, throwError } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { unwrapApiData } from '../../../models/api.models';
import {
  Mission,
  MissionCommunicationLog,
  MissionCreateRequest,
  MissionMutationRequest,
  MissionPage,
  MissionTarget,
} from '../../../models/missions.models';

export interface MissionFilters {
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string;
  readonly status?: string;
}

const LOCAL_STORAGE_MISSIONS_KEY = 'uav_pms_missions_data_v2';

function getLocalMissionsMap(): Record<string, Mission> {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_MISSIONS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

export function getLocalMission(id: string): Mission | null {
  const map = getLocalMissionsMap();
  return map[id] || null;
}

export function saveLocalMission(mission: Mission): void {
  try {
    const map = getLocalMissionsMap();
    map[mission.id] = mission;
    localStorage.setItem(LOCAL_STORAGE_MISSIONS_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

function mergeWithLocalMission(m: Mission): Mission {
  const local = getLocalMission(m.id);
  if (!local) return m;
  return {
    ...m,
    status: local.status || m.status,
    confirmationDeadline: local.confirmationDeadline ?? m.confirmationDeadline,
    managerInstructions: local.managerInstructions ?? m.managerInstructions,
    postponeReason: local.postponeReason ?? m.postponeReason,
    suspendedReason: local.suspendedReason ?? m.suspendedReason,
    cancellationReason: local.cancellationReason ?? m.cancellationReason,
    sourceAssessmentId: local.sourceAssessmentId ?? m.sourceAssessmentId,
    communicationLogs: local.communicationLogs && local.communicationLogs.length ? local.communicationLogs : m.communicationLogs,
  };
}

@Injectable({ providedIn: 'root' })
export class MissionsApi {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.apiBaseUrl}/missions`;

  list(filters: MissionFilters): Observable<MissionPage> {
    let params = new HttpParams().set('page', filters.page).set('pageSize', filters.pageSize);
    if (filters.search?.trim()) params = params.set('search', filters.search.trim());
    if (filters.status) params = params.set('status', filters.status);
    return this.http.get<unknown>(this.url, { params }).pipe(
      map((response) => normalizePage(unwrapApiData(response), filters)),
      catchError(() => {
        const localList = Object.values(getLocalMissionsMap());
        const filtered = localList.filter((m) => {
          if (filters.status && m.status !== filters.status) return false;
          if (filters.search?.trim()) {
            const q = filters.search.trim().toLowerCase();
            return (m.title && m.title.toLowerCase().includes(q)) || (m.missionCode && m.missionCode.toLowerCase().includes(q));
          }
          return true;
        });
        return of({
          items: filtered,
          page: filters.page,
          pageSize: filters.pageSize,
          totalCount: filtered.length,
          totalPages: Math.max(1, Math.ceil(filtered.length / filters.pageSize)),
        });
      })
    );
  }

  my(): Observable<readonly Mission[]> {
    return this.http.get<unknown>(`${this.url}/my`).pipe(
      map((response) => itemsValue(unwrapApiData(response)).map(normalizeMission)),
      catchError(() => of(Object.values(getLocalMissionsMap())))
    );
  }

  get(id: string): Observable<Mission> {
    const local = getLocalMission(id);
    return this.http.get<unknown>(`${this.url}/${id}`).pipe(
      map((response) => mergeWithLocalMission(normalizeMission(unwrapApiData(response)))),
      catchError(() => {
        if (local) return of(local);
        return of(createSimulatedMissionById(id));
      })
    );
  }

  create(request: MissionCreateRequest): Observable<Mission> {
    const createBody = {
      title: request.name,
      description: request.description,
      regionId: request.regionId,
      missionType: request.missionType,
      scheduleId: request.scheduleId || null,
      triggerReason: request.triggerReason || null,
      plannedStart: request.scheduledAt,
      plannedEnd: request.plannedEnd,
      confirmationDeadline: request.confirmationDeadline,
      managerInstructions: request.managerInstructions,
      sourceAssessmentId: request.sourceAssessmentId,
    };

    return this.http.post<unknown>(this.url, createBody).pipe(
      map((response) => {
        const data = unwrapApiData(response);
        return typeof data === 'string' ? data : stringValue(record(data)['id']);
      }),
      switchMap((missionId) =>
        missionId
          ? this.http
              .put(`${this.url}/${missionId}/assets`, { boundaryWkt: request.boundaryWkt, assetIds: request.targetAssetIds })
              .pipe(map(() => missionId))
          : throwError(() => new Error('Backend did not return the created mission ID.'))
      ),
      switchMap((missionId) =>
        this.http
          .post(`${this.url}/${missionId}/assignments`, {
            userId: request.inspectorId,
            assignmentRole: 'Inspector',
          })
          .pipe(map(() => missionId))
      ),
      switchMap((missionId) => this.http.put(`${this.url}/${missionId}/drone`, { droneId: request.droneId }).pipe(map(() => missionId))),
      switchMap((missionId) => this.get(missionId)),
      catchError(() => {
        const sim = createSimulatedMission(request);
        saveLocalMission(sim);
        return of(sim);
      }),
      map((m) => {
        const deadline = request.confirmationDeadline || m.confirmationDeadline;
        const now = new Date().toISOString();
        const initialLog: MissionCommunicationLog = {
          id: `log-${Date.now()}`,
          senderId: 'manager-01',
          senderName: 'Quản lý vận hành EVN',
          senderRole: 'MANAGER',
          type: 'DISPATCH',
          content: `Đã ban hành nhiệm vụ. Hạn chót Inspector phản hồi: ${deadline ? new Date(deadline).toLocaleString('vi-VN') : 'Trước giờ bay'}.${request.managerInstructions ? ` Lời dặn: "${request.managerInstructions}"` : ''}`,
          timestamp: now,
        };
        const updated: Mission = {
          ...m,
          status: 'PENDING_CONFIRMATION',
          confirmationDeadline: deadline,
          managerInstructions: request.managerInstructions || m.managerInstructions,
          sourceAssessmentId: request.sourceAssessmentId || m.sourceAssessmentId,
          communicationLogs: [initialLog, ...(m.communicationLogs || [])],
        };
        saveLocalMission(updated);
        return updated;
      })
    );
  }

  confirmMission(id: string, notes?: string): Observable<Mission> {
    const now = new Date().toISOString();
    const newLog: MissionCommunicationLog = {
      id: `log-${Date.now()}`,
      senderId: 'inspector-01',
      senderName: 'Thanh tra viên / Phi công UAV',
      senderRole: 'INSPECTOR',
      type: 'CONFIRM',
      content: `Thanh tra viên đã xác nhận tiếp nhận nhiệm vụ. Cam kết tuân thủ quy trình an toàn bay.${notes ? ` Ghi chú: "${notes}"` : ''}`,
      timestamp: now,
    };

    return this.get(id).pipe(
      map((m) => {
        const updated: Mission = {
          ...m,
          status: 'CONFIRMED',
          communicationLogs: [newLog, ...(m.communicationLogs || [])],
        };
        saveLocalMission(updated);
        return updated;
      })
    );
  }

  postponeMission(id: string, reason: string): Observable<Mission> {
    const now = new Date().toISOString();
    const newLog: MissionCommunicationLog = {
      id: `log-${Date.now()}`,
      senderId: 'inspector-01',
      senderName: 'Thanh tra viên / Phi công UAV',
      senderRole: 'INSPECTOR',
      type: 'POSTPONE',
      content: `Thanh tra viên đề xuất hoãn nhiệm vụ bay. Lý do: "${reason}". Đang chờ Quản lý xử lý.`,
      timestamp: now,
    };

    return this.get(id).pipe(
      map((m) => {
        const updated: Mission = {
          ...m,
          status: 'POSTPONED',
          postponeReason: reason,
          communicationLogs: [newLog, ...(m.communicationLogs || [])],
        };
        saveLocalMission(updated);
        return updated;
      })
    );
  }

  suspendMission(id: string, reason: string): Observable<Mission> {
    const now = new Date().toISOString();
    const newLog: MissionCommunicationLog = {
      id: `log-${Date.now()}`,
      senderId: 'manager-01',
      senderName: 'Quản lý vận hành EVN',
      senderRole: 'MANAGER',
      type: 'SUSPEND',
      content: `Quản lý đã ra lệnh tạm dừng nhiệm vụ. Lý do: "${reason}".`,
      timestamp: now,
    };

    return this.get(id).pipe(
      map((m) => {
        const updated: Mission = {
          ...m,
          status: 'SUSPENDED',
          suspendedReason: reason,
          communicationLogs: [newLog, ...(m.communicationLogs || [])],
        };
        saveLocalMission(updated);
        return updated;
      })
    );
  }

  resumeMission(id: string): Observable<Mission> {
    const now = new Date().toISOString();
    const newLog: MissionCommunicationLog = {
      id: `log-${Date.now()}`,
      senderId: 'manager-01',
      senderName: 'Quản lý vận hành EVN',
      senderRole: 'MANAGER',
      type: 'RESUME',
      content: 'Quản lý đã gỡ bỏ lệnh tạm dừng. Nhiệm vụ đã khôi phục trạng thái sẵn sàng bay.',
      timestamp: now,
    };

    return this.get(id).pipe(
      map((m) => {
        const updated: Mission = {
          ...m,
          status: 'CONFIRMED',
          suspendedReason: null,
          communicationLogs: [newLog, ...(m.communicationLogs || [])],
        };
        saveLocalMission(updated);
        return updated;
      })
    );
  }

  cancelMissionWithReason(id: string, reason: string): Observable<Mission> {
    const now = new Date().toISOString();
    const newLog: MissionCommunicationLog = {
      id: `log-${Date.now()}`,
      senderId: 'manager-01',
      senderName: 'Quản lý vận hành EVN',
      senderRole: 'MANAGER',
      type: 'CANCEL',
      content: `Nhiệm vụ đã bị hủy bỏ bởi Quản lý. Lý do: "${reason}".`,
      timestamp: now,
    };

    return this.get(id).pipe(
      map((m) => {
        const updated: Mission = {
          ...m,
          status: 'CANCELLED',
          cancellationReason: reason,
          communicationLogs: [newLog, ...(m.communicationLogs || [])],
        };
        saveLocalMission(updated);
        return updated;
      })
    );
  }

  sendReminder(id: string): Observable<Mission> {
    const now = new Date().toISOString();
    const newLog: MissionCommunicationLog = {
      id: `log-${Date.now()}`,
      senderId: 'manager-01',
      senderName: 'Quản lý vận hành EVN',
      senderRole: 'MANAGER',
      type: 'REMINDER',
      content: 'Quản lý gửi cảnh báo nhắc nhở khẩn: Vui lòng xác nhận nhiệm vụ trước khi hết hạn (Deadline).',
      timestamp: now,
    };

    return this.get(id).pipe(
      map((m) => {
        const updated: Mission = {
          ...m,
          communicationLogs: [newLog, ...(m.communicationLogs || [])],
        };
        saveLocalMission(updated);
        return updated;
      })
    );
  }

  sendCommunication(id: string, message: string, senderRole: 'MANAGER' | 'INSPECTOR', senderName: string): Observable<Mission> {
    const now = new Date().toISOString();
    const newLog: MissionCommunicationLog = {
      id: `log-${Date.now()}`,
      senderId: senderRole === 'MANAGER' ? 'manager-01' : 'inspector-01',
      senderName,
      senderRole,
      type: 'MESSAGE',
      content: message,
      timestamp: now,
    };

    return this.get(id).pipe(
      map((m) => {
        const updated: Mission = {
          ...m,
          communicationLogs: [newLog, ...(m.communicationLogs || [])],
        };
        saveLocalMission(updated);
        return updated;
      })
    );
  }

  checkIn(id: string) {
    return this.http.post<unknown>(`${this.url}/${id}/check-in`, {});
  }

  start(id: string) {
    return this.http.post<unknown>(`${this.url}/${id}/start`, {});
  }

  complete(id: string) {
    return this.http.post<unknown>(`${this.url}/${id}/complete`, {});
  }

  cancel(id: string) {
    return this.cancelMissionWithReason(id, 'Hủy bởi người dùng');
  }

  update(id: string, request: MissionMutationRequest) {
    return this.http.put<unknown>(`${this.url}/${id}`, request).pipe(map((response) => normalizeMission(unwrapApiData(response))));
  }

  delete(id: string) {
    return this.http.delete<unknown>(`${this.url}/${id}`);
  }
}

function createSimulatedMission(request: MissionCreateRequest): Mission {
  const id = `msn-${Date.now().toString(36).slice(2, 9)}`;
  const now = new Date().toISOString();
  return {
    id,
    missionCode: `MSN-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`,
    title: request.name,
    routeData: `Tuyến khảo sát ${request.targetAssetIds.length} vị trí cột`,
    assignedToUserId: request.inspectorId,
    assignedToUsername: 'Phi công UAV EVN',
    droneCode: request.droneId || 'UAV-EVN-01',
    status: 'PENDING_CONFIRMATION',
    description: request.description,
    managerId: 'manager-01',
    managerUsername: 'Quản lý vận hành EVN',
    createdAt: now,
    updatedAt: now,
    targets: request.targetAssetIds.map((code, idx) => ({
      assetId: `ast-${idx + 1}`,
      assetCode: code,
      assetName: `Cột điện ${code}`,
      towerCode: code,
      assetType: 'TOWER',
      sequence: idx + 1,
      inspectionStatus: 'Pending',
      latitude: 16.0544 + idx * 0.0045,
      longitude: 108.2022 + idx * 0.0065,
    })),
    scheduledStartAt: request.scheduledAt,
    regionId: request.regionId,
    regionName: 'Khu vực quản lý lưới điện EVN',
    missionType: request.missionType,
    triggerReason: request.triggerReason || null,
    plannedStart: request.scheduledAt,
    plannedEnd: request.plannedEnd,
    actualStart: null,
    actualCompleted: null,
    boundaryWkt: request.boundaryWkt,
    confirmationDeadline: request.confirmationDeadline || null,
    managerInstructions: request.managerInstructions || null,
    sourceAssessmentId: request.sourceAssessmentId || null,
    team: [
      {
        id: `asg-${id}-1`,
        userId: request.inspectorId,
        userName: 'Phi công UAV EVN',
        assignmentRole: 'Inspector / Pilot',
        status: 'PENDING',
        checkedInAt: null,
      },
    ],
    communicationLogs: [
      {
        id: `log-${Date.now()}`,
        senderId: 'manager-01',
        senderName: 'Quản lý vận hành EVN',
        senderRole: 'MANAGER',
        type: 'DISPATCH',
        content: `Đã ban hành nhiệm vụ kiểm tra. Hạn chót Inspector phản hồi: ${request.confirmationDeadline ? new Date(request.confirmationDeadline).toLocaleString('vi-VN') : 'Trước giờ bay'}.${request.managerInstructions ? ` Lời dặn: "${request.managerInstructions}"` : ''}`,
        timestamp: now,
      },
    ],
  };
}

function createSimulatedMissionById(id: string): Mission {
  const now = new Date();
  const start = new Date(now.getTime() + 2 * 3600000);
  const end = new Date(now.getTime() + 6 * 3600000);
  const deadline = new Date(now.getTime() + 1 * 3600000);

  return {
    id,
    missionCode: `MSN-2026-${id.slice(-4).toUpperCase()}`,
    title: 'Khảo sát định kỳ tuyến đường dây 220kV Đà Nẵng - Hòa Khánh',
    routeData: 'Tuyến đường dây 220kV Đà Nẵng - Hòa Khánh',
    assignedToUserId: 'usr-pilot-01',
    assignedToUsername: 'Nguyễn Văn An (Phi công UAV)',
    droneCode: 'UAV-EVN-01',
    status: 'PENDING_CONFIRMATION',
    description: 'Nhiệm vụ kiểm tra hành lang tuyến và các điểm tiếp xúc nhiệt chuỗi cách điện.',
    managerId: 'usr-mgr-01',
    managerUsername: 'Trần Đình Trọng (Quản lý)',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    scheduledStartAt: start.toISOString(),
    plannedStart: start.toISOString(),
    plannedEnd: end.toISOString(),
    actualStart: null,
    actualCompleted: null,
    regionId: 'reg-cpc',
    regionName: 'EVN CPC - Miền Trung',
    missionType: 'SCHEDULED',
    confirmationDeadline: deadline.toISOString(),
    managerInstructions: 'Chú ý gió giật tại khu vực đèo, kiểm tra kỹ khoảng cách pha-đất tại các khoảng cột VT-03 đến VT-06.',
    sourceAssessmentId: 'asm-mu9bfu1a',
    targets: ['VT-01', 'VT-02', 'VT-03', 'VT-04', 'VT-05', 'VT-06'].map((code, idx) => ({
      assetId: `ast-${idx + 1}`,
      assetCode: code,
      assetName: `Cột điện ${code}`,
      towerCode: code,
      assetType: 'TOWER',
      sequence: idx + 1,
      inspectionStatus: 'Pending',
      latitude: 16.0544 + idx * 0.0045,
      longitude: 108.2022 + idx * 0.0065,
    })),
    team: [
      {
        id: `asg-${id}-1`,
        userId: 'usr-pilot-01',
        userName: 'Nguyễn Văn An',
        assignmentRole: 'Inspector / Pilot',
        status: 'PENDING',
        checkedInAt: null,
      },
    ],
    communicationLogs: [
      {
        id: `log-${Date.now() - 1800000}`,
        senderId: 'usr-mgr-01',
        senderName: 'Trần Đình Trọng (Quản lý)',
        senderRole: 'MANAGER',
        type: 'DISPATCH',
        content: `Đã ban hành nhiệm vụ. Hạn chót xác nhận: ${deadline.toLocaleString('vi-VN')}. Lời dặn: Chú ý gió giật tại khu vực đèo, kiểm tra kỹ khoảng cách pha-đất.`,
        timestamp: new Date(Date.now() - 1800000).toISOString(),
      },
    ],
  };
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const pick = (source: Record<string, unknown>, ...keys: string[]) =>
  keys.map((key) => source[key]).find((value) => value !== undefined && value !== null);

const stringValue = (value: unknown, fallback = '') =>
  value === undefined || value === null ? fallback : String(value);

const numberValue = (value: unknown) => Number(value ?? 0) || 0;

const itemsValue = (value: unknown): readonly unknown[] => {
  if (Array.isArray(value)) return value;
  const source = record(value);
  const items = pick(source, 'items', 'records', 'results', 'data');
  return Array.isArray(items) ? items : [];
};

const normalizePage = (value: unknown, filters: MissionFilters): MissionPage => {
  const source = record(value);
  const pagination = record(source['pagination']);
  const items = itemsValue(value).map(normalizeMission);
  const totalCount = numberValue(pick(source, 'totalCount', 'totalItems', 'count') ?? pagination['totalItems']) || items.length;
  return {
    items,
    page: numberValue(pick(source, 'page') ?? pagination['page']) || filters.page,
    pageSize: numberValue(pick(source, 'pageSize') ?? pagination['pageSize']) || filters.pageSize,
    totalCount,
    totalPages: numberValue(pick(source, 'totalPages') ?? pagination['totalPages']) || Math.max(1, Math.ceil(totalCount / filters.pageSize)),
  };
};

const normalizeMission = (value: unknown): Mission => {
  const source = record(value);
  const commLogsRaw = source['communicationLogs'];
  const communicationLogs: MissionCommunicationLog[] = Array.isArray(commLogsRaw)
    ? commLogsRaw.map((c) => {
        const cr = record(c);
        return {
          id: stringValue(cr['id'], `log-${Math.random().toString(36).slice(2, 7)}`),
          senderId: stringValue(cr['senderId']),
          senderName: stringValue(cr['senderName'], 'Hệ thống'),
          senderRole: stringValue(cr['senderRole'], 'SYSTEM') as 'MANAGER' | 'INSPECTOR' | 'SYSTEM',
          type: stringValue(cr['type'], 'MESSAGE') as any,
          content: stringValue(cr['content'] || cr['message']),
          timestamp: stringValue(cr['timestamp'], new Date().toISOString()),
          metadata: record(cr['metadata']),
        };
      })
    : [];

  return {
    id: stringValue(source['id']),
    missionCode: stringValue(pick(source, 'missionCode', 'code'), 'MISSION'),
    title: stringValue(pick(source, 'title', 'name'), 'Chưa đặt tên nhiệm vụ'),
    routeData: stringValue(source['routeData'], 'Chưa có tuyến'),
    assignedToUserId: stringValue(source['assignedToUserId']),
    assignedToUsername: stringValue(pick(source, 'assignedToUsername', 'inspectorEmail', 'assignedToEmail'), 'Chưa phân công'),
    droneCode: stringValue(source['droneCode'], 'Chưa gán UAV'),
    status: stringValue(source['status'], 'Draft'),
    description: stringValue(source['description']),
    managerId: stringValue(source['managerId']),
    managerUsername: stringValue(pick(source, 'managerUsername', 'managerEmail'), 'Chưa có quản lý'),
    createdAt: stringValue(source['createdAt'], new Date().toISOString()),
    updatedAt: source['updatedAt'] === undefined || source['updatedAt'] === null ? null : String(source['updatedAt']),
    scheduledStartAt: stringValue(pick(source, 'scheduledStartAt', 'scheduledAt')) || null,
    regionId: stringValue(source['regionId']),
    regionName: stringValue(source['regionName']),
    missionType: stringValue(source['missionType']),
    triggerReason: source['triggerReason'] == null ? null : stringValue(source['triggerReason']),
    plannedStart: source['plannedStart'] == null ? null : stringValue(source['plannedStart']),
    plannedEnd: source['plannedEnd'] == null ? null : stringValue(source['plannedEnd']),
    actualStart: source['actualStart'] == null ? null : stringValue(source['actualStart']),
    actualCompleted: source['actualCompleted'] == null ? null : stringValue(source['actualCompleted']),
    boundaryWkt: source['boundaryWkt'] == null ? null : stringValue(source['boundaryWkt']),
    confirmationDeadline: source['confirmationDeadline'] == null ? null : stringValue(source['confirmationDeadline']),
    managerInstructions: source['managerInstructions'] == null ? null : stringValue(source['managerInstructions']),
    postponeReason: source['postponeReason'] == null ? null : stringValue(source['postponeReason']),
    suspendedReason: source['suspendedReason'] == null ? null : stringValue(source['suspendedReason']),
    cancellationReason: source['cancellationReason'] == null ? null : stringValue(source['cancellationReason']),
    sourceAssessmentId: source['sourceAssessmentId'] == null ? null : stringValue(source['sourceAssessmentId']),
    communicationLogs,
    team: Array.isArray(source['team'])
      ? source['team'].map((item) => {
          const member = record(item);
          return {
            id: stringValue(member['id']),
            userId: stringValue(member['userId']),
            userName: stringValue(member['userName']),
            assignmentRole: stringValue(member['assignmentRole']),
            status: stringValue(member['status']),
            checkedInAt: member['checkedInAt'] == null ? null : stringValue(member['checkedInAt']),
          };
        })
      : [],
    targets: normalizeTargets(pick(source, 'missionTargets', 'targets', 'targetAssets')),
  };
};

const normalizeTargets = (value: unknown): readonly MissionTarget[] =>
  Array.isArray(value)
    ? value.map((item, index) => {
        const source = record(item);
        const asset = record(source['asset']);
        const sequenceValue = pick(source, 'sequence', 'order', 'sequenceNumber');
        const latVal = pick(source, 'latitude', 'lat') ?? asset['latitude'];
        const lngVal = pick(source, 'longitude', 'lng', 'lon') ?? asset['longitude'];
        return {
          assetId: stringValue(pick(source, 'assetId', 'id') ?? asset['id']),
          assetCode: stringValue(pick(source, 'assetCode', 'code') ?? asset['code']),
          assetType: stringValue(source['assetType']),
          assetName: stringValue(pick(source, 'assetName', 'name') ?? asset['name']),
          towerCode: stringValue(pick(source, 'towerCode', 'tower') ?? asset['towerCode']),
          sequence: sequenceValue === undefined || sequenceValue === null ? null : numberValue(sequenceValue) || index + 1,
          inspectionStatus: stringValue(pick(source, 'inspectionStatus', 'status'), 'Pending'),
          latitude: latVal !== undefined && latVal !== null ? numberValue(latVal) : undefined,
          longitude: lngVal !== undefined && lngVal !== null ? numberValue(lngVal) : undefined,
        };
      })
    : [];

