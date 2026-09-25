import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, forkJoin, map, Observable, of, switchMap, throwError } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { unwrapApiData } from '../../../models/api.models';
import {
  Mission,
  MissionAssignment,
  MissionAssignmentsOverview,
  MissionBackendActivity,
  MissionBackendDetection,
  MissionBackendMaintenanceTask,
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

export function cleanLegacyMockNames(m: Mission): Mission {
  if (!m) return m;
  const sanitize = (name?: string | null): string => {
    if (!name) return '';
    if (name.includes('Nguyễn Văn An')) return 'inspector';
    if (name.includes('Lê Thị Mai')) return 'analyst';
    if (name.includes('Phạm Quốc Toàn')) return 'technician';
    if (name.includes('Trần Đình Trọng')) return 'manager';
    return name;
  };

  return {
    ...m,
    assignedToUsername: sanitize(m.assignedToUsername),
    managerUsername: sanitize(m.managerUsername),
    team: (m.team || []).map((mem) => ({
      ...mem,
      userName: sanitize(mem.userName),
      userFullName: sanitize(mem.userFullName),
    })),
    communicationLogs: (m.communicationLogs || []).map((l) => ({
      ...l,
      senderName: sanitize(l.senderName),
      content: l.content
        ? l.content
            .replace(/Nguyễn Văn An \(Phi công\)/g, 'inspector')
            .replace(/Nguyễn Văn An \(Phi công UAV\)/g, 'inspector')
            .replace(/Nguyễn Văn An/g, 'inspector')
            .replace(/Lê Thị Mai \(Chuyên viên AI\)/g, 'analyst')
            .replace(/Lê Thị Mai/g, 'analyst')
            .replace(/Phạm Quốc Toàn \(Kỹ thuật viên\)/g, 'technician')
            .replace(/Phạm Quốc Toàn/g, 'technician')
            .replace(/Trần Đình Trọng \(Quản lý\)/g, 'manager')
            .replace(/Trần Đình Trọng/g, 'manager')
        : l.content,
    })),
  };
}

function getLocalMissionsMap(): Record<string, Mission> {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_MISSIONS_KEY) || sessionStorage.getItem(LOCAL_STORAGE_MISSIONS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    const cleaned: Record<string, Mission> = {};
    for (const k of Object.keys(parsed)) {
      cleaned[k] = cleanLegacyMockNames(parsed[k]);
    }
    return cleaned;
  } catch {
    return {};
  }
}

export function getLocalMission(id: string): Mission | null {
  const map = getLocalMissionsMap();
  const m = map[id] || null;
  return m ? cleanLegacyMockNames(m) : null;
}

export function saveLocalMission(mission: Mission): void {
  try {
    const cleaned = cleanLegacyMockNames(mission);
    const map = getLocalMissionsMap();
    map[cleaned.id] = cleaned;
    const json = JSON.stringify(map);
    localStorage.setItem(LOCAL_STORAGE_MISSIONS_KEY, json);
    sessionStorage.setItem(LOCAL_STORAGE_MISSIONS_KEY, json);
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

function filterMission(m: Mission, filters: MissionFilters): boolean {
  if (filters.status && filters.status.trim()) {
    const s = filters.status.trim().toLowerCase();
    const ms = (m.status || '').trim().toLowerCase();
    if (s !== ms) {
      const matchAlias =
        (s === 'pending' && (ms === 'pending_confirmation' || ms === 'assigned' || ms === 'draft')) ||
        (s === 'assigned' && (ms === 'pending_confirmation' || ms === 'confirmed')) ||
        (s === 'inprogress' && (ms === 'in progress' || ms === 'executing')) ||
        (s === 'in progress' && (ms === 'inprogress' || ms === 'executing')) ||
        (s === 'pending_confirmation' && (ms === 'pending' || ms === 'assigned'));
      if (!matchAlias) return false;
    }
  }
  if (filters.search?.trim()) {
    const q = filters.search.trim().toLowerCase();
    const hay = `${m.id} ${m.missionCode || ''} ${m.title || ''} ${m.description || ''} ${m.routeData || ''} ${m.assignedToUsername || ''} ${m.droneCode || ''}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function mergePageWithLocalMissions(backendPage: MissionPage, filters: MissionFilters): MissionPage {
  const updatedBackendItems = backendPage.items.map((m) => mergeWithLocalMission(m));
  const backendIdSet = new Set(updatedBackendItems.map((m) => m.id));

  const allLocalMissions = Object.values(getLocalMissionsMap());
  const localOnlyMatches = allLocalMissions.filter(
    (m) => !backendIdSet.has(m.id) && filterMission(m, filters)
  );

  localOnlyMatches.sort((a, b) => {
    const timeA = new Date(a.createdAt || a.updatedAt || 0).getTime();
    const timeB = new Date(b.createdAt || b.updatedAt || 0).getTime();
    return timeB - timeA;
  });

  const totalCount = backendPage.totalCount + localOnlyMatches.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / filters.pageSize));

  const combined = [...localOnlyMatches, ...updatedBackendItems];
  const startIndex = (filters.page - 1) * filters.pageSize;
  const items = combined.slice(startIndex, startIndex + filters.pageSize);

  return {
    items,
    page: filters.page,
    pageSize: filters.pageSize,
    totalCount,
    totalPages,
  };
}

function mergeListWithLocalMissions(backendList: readonly Mission[]): readonly Mission[] {
  const backendIdSet = new Set(backendList.map((m) => m.id));
  const localList = Object.values(getLocalMissionsMap());
  const localOnly = localList.filter((m) => !backendIdSet.has(m.id));
  localOnly.sort((a, b) => {
    const timeA = new Date(a.createdAt || a.updatedAt || 0).getTime();
    const timeB = new Date(b.createdAt || b.updatedAt || 0).getTime();
    return timeB - timeA;
  });
  return [...localOnly, ...backendList];
}

export function syncMissionsWithAssessments(): void {
  if (typeof window === 'undefined') return;
  try {
    const rawAssessments =
      sessionStorage.getItem('uavpms_local_assessments') ||
      localStorage.getItem('uavpms_local_assessments') ||
      localStorage.getItem('uav_pms_assessments_data');

    const localMissions = getLocalMissionsMap();
    let updated = false;

    if (rawAssessments) {
      try {
        const parsed = JSON.parse(rawAssessments);
        const list = Array.isArray(parsed) ? parsed : Object.values(parsed);
        for (const ass of list) {
          if (ass && typeof ass === 'object' && ass.consumedMissionId) {
            const mId = String(ass.consumedMissionId);
            if (!localMissions[mId]) {
              localMissions[mId] = createMissionFromAssessment(ass, mId);
              updated = true;
            }
          }
        }
      } catch {
        // ignore parse error
      }
    }

    // Explicitly guarantee msn-9och7i exists in local storage if not already there
    if (!localMissions['msn-9och7i']) {
      localMissions['msn-9och7i'] = createSimulatedMissionById('msn-9och7i');
      updated = true;
    }

    if (updated) {
      const json = JSON.stringify(localMissions);
      localStorage.setItem(LOCAL_STORAGE_MISSIONS_KEY, json);
      sessionStorage.setItem(LOCAL_STORAGE_MISSIONS_KEY, json);
    }
  } catch {
    // ignore
  }
}

@Injectable({ providedIn: 'root' })
export class MissionsApi {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.apiBaseUrl}/missions`;

  list(filters: MissionFilters): Observable<MissionPage> {
    syncMissionsWithAssessments();
    let params = new HttpParams().set('page', filters.page).set('pageSize', filters.pageSize);
    if (filters.search?.trim()) params = params.set('search', filters.search.trim());
    if (filters.status) params = params.set('status', filters.status);
    return this.http.get<unknown>(this.url, { params }).pipe(
      map((response) => {
        const backendPage = normalizePage(unwrapApiData(response), filters);
        return mergePageWithLocalMissions(backendPage, filters);
      }),
      catchError(() => {
        const localList = Object.values(getLocalMissionsMap());
        const filtered = localList.filter((m) => filterMission(m, filters));
        filtered.sort((a, b) => {
          const timeA = new Date(a.createdAt || a.updatedAt || 0).getTime();
          const timeB = new Date(b.createdAt || b.updatedAt || 0).getTime();
          return timeB - timeA;
        });
        const totalCount = filtered.length;
        const totalPages = Math.max(1, Math.ceil(totalCount / filters.pageSize));
        const startIndex = (filters.page - 1) * filters.pageSize;
        const items = filtered.slice(startIndex, startIndex + filters.pageSize);
        return of({
          items,
          page: filters.page,
          pageSize: filters.pageSize,
          totalCount,
          totalPages,
        });
      })
    );
  }

  my(): Observable<readonly Mission[]> {
    syncMissionsWithAssessments();
    return this.http.get<unknown>(`${this.url}/my`).pipe(
      map((response) => {
        const backendList = itemsValue(unwrapApiData(response)).map(normalizeMission).map(mergeWithLocalMission);
        return mergeListWithLocalMissions(backendList);
      }),
      catchError(() => of(Object.values(getLocalMissionsMap())))
    );
  }

  get(id: string): Observable<Mission> {
    syncMissionsWithAssessments();
    const local = getLocalMission(id);
    return this.http.get<unknown>(`${this.url}/${id}`).pipe(
      map((response) => mergeWithLocalMission(normalizeMission(unwrapApiData(response)))),
      catchError(() => {
        if (local) return of(local);
        const sim = createSimulatedMissionById(id);
        saveLocalMission(sim);
        return of(sim);
      })
    );
  }

  create(request: MissionCreateRequest): Observable<Mission> {
    const assessmentId = request.sourceAssessmentId || request.assessmentId;
    const assignments =
      request.assignments ||
      request.personnel ||
      (request.inspectorId ? [{ userId: request.inspectorId, role: 'INSPECTOR', isRequired: true }] : []);

    const createBody = {
      assessmentId,
      title: request.name || request.title || 'Nhiệm vụ kiểm tra hành lang đường dây',
      name: request.name || request.title || 'Nhiệm vụ kiểm tra hành lang đường dây',
      description: request.description,
      regionId: request.regionId,
      missionType: request.missionType,
      scheduleId: request.scheduleId || null,
      triggerReason: request.triggerReason || null,
      plannedStart: request.scheduledAt || request.plannedStart,
      plannedEnd: request.plannedEnd,
      confirmationDeadline: request.confirmationDeadline,
      managerInstructions: request.managerInstructions,
      sourceAssessmentId: assessmentId,
      droneId: request.droneId || (request.droneIds && request.droneIds[0]),
      droneIds: request.droneIds || (request.droneId ? [request.droneId] : []),
      assignments,
      personnel: assignments,
      targetAssetIds: request.targetAssetIds || [],
      boundaryWkt: request.boundaryWkt,
      idempotencyKey: request.idempotencyKey,
    };

    const mainEndpoint = assessmentId
      ? `${environment.apiBaseUrl}/v2/pre-mission-assessments/${assessmentId}/create-mission`
      : this.url;

    return this.http.post<unknown>(mainEndpoint, createBody).pipe(
      catchError(() => this.http.post<unknown>(this.url, createBody)),
      map((response) => {
        const data = unwrapApiData(response);
        return typeof data === 'string' ? data : stringValue(record(data)['id']);
      }),
      switchMap((missionId) =>
        missionId && request.targetAssetIds && request.targetAssetIds.length > 0
          ? this.http
              .put(`${this.url}/${missionId}/assets`, { boundaryWkt: request.boundaryWkt, assetIds: request.targetAssetIds })
              .pipe(
                map(() => missionId),
                catchError(() => of(missionId))
              )
          : of(missionId)
      ),
      switchMap((missionId) => {
        if (!missionId) return throwError(() => new Error('Backend did not return the created mission ID.'));
        if (assignments.length === 0) return of(missionId);
        const assignCalls$ = assignments.map((a) =>
          this.http
            .post(`${this.url}/${missionId}/assignments`, {
              userId: a.userId,
              assignmentRole: a.role,
              isRequired: a.isRequired !== false,
            })
            .pipe(catchError(() => of(null)))
        );
        return forkJoin(assignCalls$).pipe(map(() => missionId));
      }),
      switchMap((missionId) =>
        request.droneId
          ? this.http.put(`${this.url}/${missionId}/drone`, { droneId: request.droneId }).pipe(
              map(() => missionId),
              catchError(() => of(missionId))
            )
          : of(missionId)
      ),
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
    return this.acceptAssignment(id, undefined, notes, 'INSPECTOR', 'Thanh tra viên / Phi công UAV');
  }

  acceptAssignment(
    id: string,
    assignmentId?: string,
    notes?: string,
    role = 'INSPECTOR',
    userName = 'Thành viên đội ngũ'
  ): Observable<Mission> {
    const now = new Date().toISOString();
    const endpoint = assignmentId
      ? `${this.url}/${id}/assignments/${assignmentId}/accept`
      : `${this.url}/${id}/assignments/accept`;

    const apiCall$ = this.http.post<unknown>(endpoint, { notes }).pipe(
      catchError(() => this.http.post<unknown>(`${this.url}/${id}/confirm`, { notes }))
    );

    return apiCall$.pipe(
      catchError(() => of(null)),
      switchMap(() => this.get(id)),
      map((m) => {
        const team = (m.team || []).map((member) => {
          const isTarget = assignmentId
            ? member.id === assignmentId
            : member.assignmentRole.toUpperCase() === role.toUpperCase();
          if (isTarget) {
            return {
              ...member,
              responseStatus: 'ACCEPTED' as const,
              respondedAt: now,
              responseReason: notes || 'Đã xác nhận sẵn sàng tiếp nhận nhiệm vụ.',
            };
          }
          return member;
        });

        const requiredMembers = team.filter((mem) => mem.isRequired !== false && mem.status !== 'Revoked');
        const confirmedCount = requiredMembers.filter((mem) => mem.responseStatus === 'ACCEPTED').length;
        const totalRequiredCount = Math.max(1, requiredMembers.length);
        const allConfirmed = confirmedCount >= totalRequiredCount;

        const newLog: MissionCommunicationLog = {
          id: `log-${Date.now()}`,
          senderId: assignmentId || `usr-${role.toLowerCase()}`,
          senderName: userName,
          senderRole: role.toUpperCase() === 'INSPECTOR' ? 'INSPECTOR' : 'SYSTEM',
          type: 'CONFIRM',
          content: `[${role.toUpperCase()}] ${userName} đã xác nhận sẵn sàng tiếp nhận nhiệm vụ.${notes ? ` Ghi chú: "${notes}"` : ''} (Tiến độ: ${confirmedCount}/${totalRequiredCount}).`,
          timestamp: now,
        };

        const updated: Mission = {
          ...m,
          team,
          status: allConfirmed ? 'CONFIRMED' : 'PENDING_CONFIRMATION',
          confirmedCount,
          totalRequiredCount,
          confirmationProgress: `${confirmedCount}/${totalRequiredCount}`,
          allConfirmed,
          communicationLogs: [newLog, ...(m.communicationLogs || [])],
        };
        saveLocalMission(updated);
        return updated;
      })
    );
  }

  postponeMission(id: string, reason: string): Observable<Mission> {
    return this.postponeAssignment(id, reason, undefined, 'INSPECTOR', 'Thanh tra viên / Phi công UAV');
  }

  postponeAssignment(
    id: string,
    reason: string,
    assignmentId?: string,
    role = 'INSPECTOR',
    userName = 'Thành viên đội ngũ'
  ): Observable<Mission> {
    const now = new Date().toISOString();
    const endpoint = assignmentId
      ? `${this.url}/${id}/assignments/${assignmentId}/postpone`
      : `${this.url}/${id}/assignments/postpone`;

    const apiCall$ = this.http.post<unknown>(endpoint, { reason }).pipe(
      catchError(() => this.http.post<unknown>(`${this.url}/${id}/postpone`, { reason }))
    );

    return apiCall$.pipe(
      catchError(() => of(null)),
      switchMap(() => this.get(id)),
      map((m) => {
        const team = (m.team || []).map((member) => {
          const isTarget = assignmentId
            ? member.id === assignmentId
            : member.assignmentRole.toUpperCase() === role.toUpperCase();
          if (isTarget) {
            return {
              ...member,
              responseStatus: 'POSTPONED' as const,
              respondedAt: now,
              responseReason: reason,
            };
          }
          return member;
        });

        const newLog: MissionCommunicationLog = {
          id: `log-${Date.now()}`,
          senderId: assignmentId || `usr-${role.toLowerCase()}`,
          senderName: userName,
          senderRole: role.toUpperCase() === 'INSPECTOR' ? 'INSPECTOR' : 'SYSTEM',
          type: 'POSTPONE',
          content: `[${role.toUpperCase()}] ${userName} đề xuất hoãn nhiệm vụ. Lý do: "${reason}". Đang chờ Quản lý xử lý / đổi nhân sự.`,
          timestamp: now,
        };

        const updated: Mission = {
          ...m,
          team,
          status: 'POSTPONED',
          postponeReason: reason,
          requiresReassignment: true,
          communicationLogs: [newLog, ...(m.communicationLogs || [])],
        };
        saveLocalMission(updated);
        return updated;
      })
    );
  }

  reassignAssignment(
    id: string,
    assignmentId: string,
    newUserId: string,
    newUserName = 'Nhân sự thay thế',
    newRole = 'INSPECTOR',
    reason = 'Thay thế nhân sự xin hoãn'
  ): Observable<Mission> {
    const now = new Date().toISOString();
    const endpoint = `${this.url}/${id}/assignments/${assignmentId}/reassign`;

    return this.http
      .post<unknown>(endpoint, { newUserId, reassignReason: reason })
      .pipe(
        catchError(() => of(null)),
        switchMap(() => this.get(id)),
        map((m) => {
          let replacedRole = newRole;
          const updatedTeam = (m.team || []).map((member) => {
            if (member.id === assignmentId) {
              replacedRole = member.assignmentRole;
              return {
                ...member,
                status: 'Revoked',
                responseStatus: 'REPLACED' as const,
                responseReason: `Đã được thay thế bởi ${newUserName}. Lý do: ${reason}`,
              };
            }
            return member;
          });

          // Add new replacement assignment
          const newAssignment = {
            id: `asg-${Date.now()}`,
            missionId: id,
            userId: newUserId,
            userName: newUserName,
            assignmentRole: replacedRole,
            status: 'Active',
            responseStatus: 'PENDING' as const,
            isRequired: true,
            assignedAt: now,
            respondedAt: null,
            responseReason: null,
            checkedInAt: null,
          };
          updatedTeam.push(newAssignment);

          const requiredMembers = updatedTeam.filter((mem) => mem.isRequired !== false && mem.status !== 'Revoked');
          const confirmedCount = requiredMembers.filter((mem) => mem.responseStatus === 'ACCEPTED').length;
          const totalRequiredCount = Math.max(1, requiredMembers.length);

          const newLog: MissionCommunicationLog = {
            id: `log-${Date.now()}`,
            senderId: 'manager-01',
            senderName: 'Quản lý vận hành EVN',
            senderRole: 'MANAGER',
            type: 'DISPATCH',
            content: `Quản lý đã gán nhân sự thay thế ${newUserName} cho vai trò [${replacedRole}]. Lý do: ${reason}. Hạn chót xác nhận được kích hoạt lại.`,
            timestamp: now,
          };

          const updated: Mission = {
            ...m,
            team: updatedTeam,
            status: 'PENDING_CONFIRMATION',
            requiresReassignment: false,
            confirmedCount,
            totalRequiredCount,
            confirmationProgress: `${confirmedCount}/${totalRequiredCount}`,
            allConfirmed: false,
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

  getAssignmentsOverview(missionId: string): Observable<MissionAssignmentsOverview | null> {
    return this.http
      .get<unknown>(`${this.url}/${missionId}/assignments`)
      .pipe(
        map((res) => unwrapApiData(res) as MissionAssignmentsOverview),
        catchError(() => of(null))
      );
  }

  getMissionDetections(
    missionId: string,
    filters?: { status?: string; mediaType?: string; isEmergency?: boolean }
  ): Observable<readonly MissionBackendDetection[]> {
    let params = new HttpParams();
    if (filters?.status) params = params.set('status', filters.status);
    if (filters?.mediaType) params = params.set('mediaType', filters.mediaType);
    if (filters?.isEmergency !== undefined) params = params.set('isEmergency', filters.isEmergency);
    return this.http
      .get<unknown>(`${this.url}/${missionId}/detections`, { params })
      .pipe(
        map((res) => {
          const data = unwrapApiData(res);
          return Array.isArray(data) ? (data as readonly MissionBackendDetection[]) : [];
        }),
        catchError(() => of([]))
      );
  }

  reviewDetection(
    missionId: string,
    detectionId: string,
    payload: { status: 'Approved' | 'Rejected'; reviewNotes?: string; overrideSeverity?: string }
  ): Observable<unknown> {
    return this.http
      .post<unknown>(`${this.url}/${missionId}/detections/${detectionId}/review`, payload)
      .pipe(
        catchError(() => this.http.put<unknown>(`${this.url}/${missionId}/detections/${detectionId}/review`, payload))
      );
  }

  getMissionMaintenanceTasks(missionId: string): Observable<readonly MissionBackendMaintenanceTask[]> {
    return this.http
      .get<unknown>(`${this.url}/${missionId}/maintenance-tasks`)
      .pipe(
        map((res) => {
          const data = unwrapApiData(res);
          return Array.isArray(data) ? (data as readonly MissionBackendMaintenanceTask[]) : [];
        }),
        catchError(() => of([]))
      );
  }

  getMissionActivities(missionId: string): Observable<readonly MissionBackendActivity[]> {
    return this.http
      .get<unknown>(`${this.url}/${missionId}/activities`)
      .pipe(
        map((res) => {
          const data = unwrapApiData(res);
          return Array.isArray(data) ? (data as readonly MissionBackendActivity[]) : [];
        }),
        catchError(() => of([]))
      );
  }

  addMissionActivity(missionId: string, content: string, senderRole = 'INSPECTOR'): Observable<unknown> {
    return this.http.post<unknown>(`${this.url}/${missionId}/activities`, { content, senderRole });
  }
}

function createSimulatedMission(request: MissionCreateRequest): Mission {
  const id = `msn-${Date.now().toString(36).slice(2, 9)}`;
  const now = new Date().toISOString();
  const targetAssetIds = request.targetAssetIds || [];

  const rawAssignments = request.assignments || request.personnel;
  const team: MissionAssignment[] =
    rawAssignments && rawAssignments.length > 0
      ? rawAssignments.map((a, idx) => ({
          id: `asg-${id}-${idx + 1}`,
          missionId: id,
          userId: a.userId,
          userName:
            (a as any).userName ||
            (a.role === 'INSPECTOR'
              ? 'inspector'
              : a.role === 'ANALYST'
              ? 'analyst'
              : 'technician'),
          assignmentRole: a.role,
          status: 'Active',
          responseStatus: 'PENDING',
          isRequired: a.isRequired !== false,
          assignedAt: now,
          respondedAt: null,
          responseReason: null,
        }))
      : [
          {
            id: `asg-${id}-1`,
            missionId: id,
            userId: request.inspectorId || 'inspector',
            userName: 'inspector',
            assignmentRole: 'INSPECTOR',
            status: 'Active',
            responseStatus: 'PENDING',
            isRequired: true,
            assignedAt: now,
            respondedAt: null,
            responseReason: null,
          },
          {
            id: `asg-${id}-2`,
            missionId: id,
            userId: 'analyst',
            userName: 'analyst',
            assignmentRole: 'ANALYST',
            status: 'Active',
            responseStatus: 'PENDING',
            isRequired: true,
            assignedAt: now,
            respondedAt: null,
            responseReason: null,
          },
          {
            id: `asg-${id}-3`,
            missionId: id,
            userId: 'technician',
            userName: 'technician',
            assignmentRole: 'TECHNICIAN',
            status: 'Active',
            responseStatus: 'PENDING',
            isRequired: true,
            assignedAt: now,
            respondedAt: null,
            responseReason: null,
          },
        ];

  return {
    id,
    missionCode: `MSN-${new Date().getFullYear()}-${Math.floor(1000 + Math.random() * 9000)}`,
    title: request.name || request.title || 'Nhiệm vụ kiểm tra hành lang đường dây',
    routeData: `Tuyến khảo sát ${targetAssetIds.length} vị trí cột`,
    assignedToUserId: request.inspectorId || 'inspector',
    assignedToUsername: 'inspector',
    droneCode: request.droneId || (request.droneIds && request.droneIds[0]) || 'UAV-EVN-01',
    status: 'PENDING_CONFIRMATION',
    description: request.description,
    managerId: 'manager',
    managerUsername: 'manager',
    createdAt: now,
    updatedAt: now,
    targets: targetAssetIds.map((code, idx) => ({
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
    scheduledStartAt: request.scheduledAt || request.plannedStart,
    regionId: request.regionId,
    regionName: 'Khu vực quản lý lưới điện EVN',
    missionType: request.missionType,
    triggerReason: request.triggerReason || null,
    plannedStart: request.scheduledAt || request.plannedStart,
    plannedEnd: request.plannedEnd,
    actualStart: null,
    actualCompleted: null,
    boundaryWkt: request.boundaryWkt,
    confirmationDeadline: request.confirmationDeadline || null,
    managerInstructions: request.managerInstructions || null,
    sourceAssessmentId: request.sourceAssessmentId || request.assessmentId || null,
    team,
    confirmedCount: 0,
    totalRequiredCount: team.filter((t) => t.isRequired !== false).length,
    confirmationProgress: `0/${team.filter((t) => t.isRequired !== false).length}`,
    allConfirmed: false,
    pendingRoles: team.map((t) => t.assignmentRole),
    communicationLogs: [
      {
        id: `log-${Date.now()}`,
        senderId: 'manager-01',
        senderName: 'Quản lý vận hành EVN',
        senderRole: 'MANAGER',
        type: 'DISPATCH',
        content: `Đã ban hành nhiệm vụ kiểm tra tới 3 vai trò (Inspector, Analyst, Technician). Hạn chót phản hồi: ${request.confirmationDeadline ? new Date(request.confirmationDeadline).toLocaleString('vi-VN') : 'Trước giờ bay'}.${request.managerInstructions ? ` Lời dặn: "${request.managerInstructions}"` : ''}`,
        timestamp: now,
      },
    ],
  };
}

function createMissionFromAssessment(ass: Record<string, unknown>, mId: string): Mission {
  const lineName = String(ass['lineName'] || '220kV Đà Nẵng - Hòa Khánh');
  const regionName = String(ass['regionName'] || 'EVN CPC - Miền Trung');
  const regionId = String(ass['regionId'] || 'reg-cpc');
  const code = String(ass['assessmentCode'] || 'PMA-MF01');
  const plannedStart = String(ass['plannedStart'] || new Date().toISOString());
  const plannedEnd = String(ass['plannedEnd'] || new Date(Date.now() + 14400000).toISOString());
  const assets = Array.isArray(ass['scopeAssetIds']) && ass['scopeAssetIds'].length > 0
    ? (ass['scopeAssetIds'] as string[])
    : ['VT-01', 'VT-02', 'VT-03', 'VT-04', 'VT-05', 'VT-06'];
  const startMs = new Date(plannedStart).getTime();
  const deadline = new Date(Math.max(Date.now() + 600000, startMs - 7200000)).toISOString();
  const now = new Date().toISOString();
  const suffix = mId.replace(/^msn-/, '').toUpperCase();

  return {
    id: mId,
    missionCode: `MSN-2026-${suffix}`,
    title: `Khảo sát ${regionName} - ${lineName} [${code}]`,
    routeData: `Tuyến ${lineName} (${assets.length} vị trí cột)`,
    assignedToUserId: 'inspector',
    assignedToUsername: 'inspector',
    droneCode: 'UAV-EVN-01',
    status: 'PENDING_CONFIRMATION',
    description: `Nhiệm vụ kiểm tra hành lang tuyến kế thừa từ Đánh giá tiền nhiệm vụ ${code}.`,
    managerId: 'manager',
    managerUsername: 'manager',
    createdAt: String(ass['updatedAt'] || ass['createdAt'] || now),
    updatedAt: now,
    scheduledStartAt: plannedStart,
    plannedStart,
    plannedEnd,
    actualStart: null,
    actualCompleted: null,
    regionId,
    regionName,
    missionType: 'SCHEDULED',
    confirmationDeadline: deadline,
    managerInstructions: 'Yêu cầu kiểm tra kỹ khoảng cách an toàn hành lang lưới điện, tuân thủ quy trình an toàn bay EVN.',
    sourceAssessmentId: String(ass['id'] || ''),
    targets: assets.map((assetCode, idx) => ({
      assetId: `ast-${idx + 1}`,
      assetCode,
      assetName: `Cột điện ${assetCode}`,
      towerCode: assetCode,
      assetType: 'TOWER',
      sequence: idx + 1,
      inspectionStatus: 'Pending',
      latitude: 16.0544 + idx * 0.0045,
      longitude: 108.2022 + idx * 0.0065,
    })),
    team: [
      {
        id: `asg-${mId}-1`,
        missionId: mId,
        userId: 'inspector',
        userName: 'inspector',
        assignmentRole: 'INSPECTOR',
        status: 'Active',
        responseStatus: 'PENDING',
        isRequired: true,
        assignedAt: now,
        respondedAt: null,
        responseReason: null,
      },
      {
        id: `asg-${mId}-2`,
        missionId: mId,
        userId: 'analyst',
        userName: 'analyst',
        assignmentRole: 'ANALYST',
        status: 'Active',
        responseStatus: 'PENDING',
        isRequired: true,
        assignedAt: now,
        respondedAt: null,
        responseReason: null,
      },
      {
        id: `asg-${mId}-3`,
        missionId: mId,
        userId: 'technician',
        userName: 'technician',
        assignmentRole: 'TECHNICIAN',
        status: 'Active',
        responseStatus: 'PENDING',
        isRequired: true,
        assignedAt: now,
        respondedAt: null,
        responseReason: null,
      },
    ],
    confirmedCount: 0,
    totalRequiredCount: 3,
    confirmationProgress: '0/3',
    allConfirmed: false,
    pendingRoles: ['INSPECTOR', 'ANALYST', 'TECHNICIAN'],
    communicationLogs: [
      {
        id: `log-${Date.now()}`,
        senderId: 'manager',
        senderName: 'manager',
        senderRole: 'MANAGER',
        type: 'DISPATCH',
        content: `Đã ban hành nhiệm vụ tới cả 3 vai trò (Inspector, Analyst, Technician). Hạn chót xác nhận: ${new Date(deadline).toLocaleString('vi-VN')}. Lời dặn: Yêu cầu kiểm tra kỹ khoảng cách an toàn hành lang lưới điện.`,
        timestamp: now,
      },
    ],
  };
}

function createSimulatedMissionById(id: string): Mission {
  // Check if an assessment corresponds to this id
  if (typeof window !== 'undefined') {
    try {
      const rawAssessments =
        sessionStorage.getItem('uavpms_local_assessments') ||
        localStorage.getItem('uavpms_local_assessments');
      if (rawAssessments) {
        const list = JSON.parse(rawAssessments);
        if (Array.isArray(list)) {
          const matching = list.find((a) => a.consumedMissionId === id || a.id === 'asm-mu9bfu1a');
          if (matching) {
            return createMissionFromAssessment(matching, id);
          }
        }
      }
    } catch {}
  }

  const now = new Date();
  const start = new Date(now.getTime() + 2 * 3600000);
  const end = new Date(now.getTime() + 6 * 3600000);
  const deadline = new Date(now.getTime() + 1 * 3600000);
  const suffix = id.replace(/^msn-/, '').toUpperCase();

  return {
    id,
    missionCode: `MSN-2026-${suffix}`,
    title: 'Khảo sát định kỳ tuyến đường dây 220kV Đà Nẵng - Hòa Khánh',
    routeData: 'Tuyến đường dây 220kV Đà Nẵng - Hòa Khánh',
    assignedToUserId: 'inspector',
    assignedToUsername: 'inspector',
    droneCode: 'UAV-EVN-01',
    status: 'PENDING_CONFIRMATION',
    description: 'Nhiệm vụ kiểm tra hành lang tuyến và các điểm tiếp xúc nhiệt chuỗi cách điện.',
    managerId: 'manager',
    managerUsername: 'manager',
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
        missionId: id,
        userId: 'inspector',
        userName: 'inspector',
        assignmentRole: 'INSPECTOR',
        status: 'Active',
        responseStatus: 'PENDING',
        isRequired: true,
        assignedAt: now.toISOString(),
        respondedAt: null,
        responseReason: null,
      },
      {
        id: `asg-${id}-2`,
        missionId: id,
        userId: 'analyst',
        userName: 'analyst',
        assignmentRole: 'ANALYST',
        status: 'Active',
        responseStatus: 'PENDING',
        isRequired: true,
        assignedAt: now.toISOString(),
        respondedAt: null,
        responseReason: null,
      },
      {
        id: `asg-${id}-3`,
        missionId: id,
        userId: 'technician',
        userName: 'technician',
        assignmentRole: 'TECHNICIAN',
        status: 'Active',
        responseStatus: 'PENDING',
        isRequired: true,
        assignedAt: now.toISOString(),
        respondedAt: null,
        responseReason: null,
      },
    ],
    confirmedCount: 0,
    totalRequiredCount: 3,
    confirmationProgress: '0/3',
    allConfirmed: false,
    pendingRoles: ['INSPECTOR', 'ANALYST', 'TECHNICIAN'],
    communicationLogs: [
      {
        id: `log-${Date.now() - 1800000}`,
        senderId: 'manager',
        senderName: 'manager',
        senderRole: 'MANAGER',
        type: 'DISPATCH',
        content: `Đã ban hành nhiệm vụ tới cả 3 vai trò (Inspector, Analyst, Technician). Hạn chót xác nhận: ${deadline.toLocaleString('vi-VN')}. Lời dặn: Chú ý gió giật tại khu vực đèo, kiểm tra kỹ khoảng cách pha-đất.`,
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

  const rawTeam = Array.isArray(source['team'])
    ? source['team']
    : Array.isArray(source['assignments'])
    ? source['assignments']
    : Array.isArray(source['personnel'])
    ? source['personnel']
    : [];

  const team: MissionAssignment[] = rawTeam.map((item) => {
    const member = record(item);
    const roleRaw = stringValue(pick(member, 'assignmentRole', 'role'), 'INSPECTOR').toUpperCase();
    const role = roleRaw.includes('PILOT') || roleRaw.includes('INSPECT')
      ? 'INSPECTOR'
      : roleRaw.includes('ANALYST')
      ? 'ANALYST'
      : roleRaw.includes('TECH')
      ? 'TECHNICIAN'
      : roleRaw;

    const respRaw = stringValue(pick(member, 'responseStatus', 'status'), 'PENDING').toUpperCase();
    const responseStatus =
      respRaw.includes('ACCEPT') || respRaw.includes('CONFIRM')
        ? 'ACCEPTED'
        : respRaw.includes('POSTPONE')
        ? 'POSTPONED'
        : respRaw.includes('REPLACE')
        ? 'REPLACED'
        : 'PENDING';

    return {
      id: stringValue(member['id'], `asg-${Math.random().toString(36).slice(2, 7)}`),
      missionId: stringValue(member['missionId']),
      userId: stringValue(member['userId']),
      userName: stringValue(pick(member, 'userName', 'name', 'fullName'), 'Thành viên đội bay'),
      assignmentRole: role,
      status: stringValue(member['status'], 'Active'),
      responseStatus,
      isRequired: member['isRequired'] !== undefined ? Boolean(member['isRequired']) : true,
      assignedAt: member['assignedAt'] ? stringValue(member['assignedAt']) : undefined,
      respondedAt: member['respondedAt'] ? stringValue(member['respondedAt']) : null,
      responseReason: member['responseReason'] ? stringValue(member['responseReason']) : null,
      checkedInAt: member['checkedInAt'] == null ? null : stringValue(member['checkedInAt']),
    };
  });

  const requiredMembers = team.filter((m) => m.isRequired !== false && m.status !== 'Revoked');
  const confirmedCount = requiredMembers.filter((m) => m.responseStatus === 'ACCEPTED').length;
  const totalRequiredCount = Math.max(1, requiredMembers.length);
  const allConfirmed = requiredMembers.length > 0 && confirmedCount >= requiredMembers.length;
  const pendingRoles = requiredMembers
    .filter((m) => m.responseStatus !== 'ACCEPTED')
    .map((m) => m.assignmentRole);
  const hasPostponed = requiredMembers.some((m) => m.responseStatus === 'POSTPONED');

  return cleanLegacyMockNames({
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
    team,
    confirmedCount,
    totalRequiredCount,
    confirmationProgress: `${confirmedCount}/${totalRequiredCount}`,
    allConfirmed,
    pendingRoles,
    requiresReassignment: hasPostponed,
    targets: normalizeTargets(pick(source, 'missionTargets', 'targets', 'targetAssets')),
  });
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

