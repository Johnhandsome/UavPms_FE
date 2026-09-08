import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { map } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { unwrapApiData } from '../../../models/api.models';
import { Mission, MissionCreateRequest, MissionMutationRequest, MissionPage, MissionTarget } from '../../../models/missions.models';

export interface MissionFilters {
  readonly page: number;
  readonly pageSize: number;
  readonly search?: string;
  readonly status?: string;
}

@Injectable({ providedIn: 'root' })
export class MissionsApi {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.apiBaseUrl}/missions`;

  list(filters: MissionFilters) {
    let params = new HttpParams().set('page', filters.page).set('pageSize', filters.pageSize);
    if (filters.search?.trim()) params = params.set('search', filters.search.trim());
    if (filters.status) params = params.set('status', filters.status);
    return this.http.get<unknown>(this.url, { params }).pipe(map((response) => normalizePage(unwrapApiData(response), filters)));
  }

  get(id: string) {
    return this.http.get<unknown>(`${this.url}/${id}`).pipe(map((response) => normalizeMission(unwrapApiData(response))));
  }

  create(request: MissionCreateRequest) {
    return this.http.post<unknown>(this.url, request).pipe(map((response) => normalizeMission(unwrapApiData(response))));
  }

  update(id: string, request: MissionMutationRequest) {
    return this.http.put<unknown>(`${this.url}/${id}`, request).pipe(map((response) => normalizeMission(unwrapApiData(response))));
  }

  getMyMissions() {
    return this.http.get<unknown>(`${this.url}/my`).pipe(
      map((response) => {
        const raw = unwrapApiData<unknown>(response);
        const items = Array.isArray(raw) ? raw : itemsValue(raw);
        return items.map(normalizeMission);
      }),
    );
  }

  delete(id: string) {
    return this.http.delete<unknown>(`${this.url}/${id}`);
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? value as Record<string, unknown> : {};

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
  return {
    id: stringValue(source['id']),
    missionCode: stringValue(pick(source, 'missionCode', 'code'), 'MISSION'),
    title: stringValue(pick(source, 'title', 'name'), 'Chưa đặt tên nhiệm vụ'),
    routeData: stringValue(source['routeData'], 'Chưa có tuyến'),
    assignedToUserId: stringValue(source['assignedToUserId']),
    assignedToUsername: stringValue(source['assignedToUsername'], 'Chưa phân công'),
    droneCode: stringValue(source['droneCode'], 'Chưa gán UAV'),
    status: stringValue(source['status'], 'Pending'),
    description: stringValue(source['description']),
    managerId: stringValue(source['managerId']),
    managerUsername: stringValue(source['managerUsername'], 'Chưa có quản lý'),
    createdAt: stringValue(source['createdAt']),
    updatedAt: source['updatedAt'] === undefined || source['updatedAt'] === null ? null : String(source['updatedAt']),
    scheduledAt: stringValue(pick(source, 'scheduledStartAt', 'scheduledAt')),
    targets: normalizeTargets(pick(source, 'missionTargets', 'targets', 'targetAssets')),
  };
};

const normalizeTargets = (value: unknown): readonly MissionTarget[] => Array.isArray(value) ? value.map((item, index) => {
  const source = record(item);
  const asset = record(source['asset']);
  const sequenceValue = pick(source, 'sequence', 'order', 'sequenceNumber');
  const latVal = pick(source, 'latitude', 'lat') ?? asset['latitude'];
  const lngVal = pick(source, 'longitude', 'lng', 'lon') ?? asset['longitude'];
  return {
    assetId: stringValue(pick(source, 'assetId', 'id') ?? asset['id']),
    assetCode: stringValue(pick(source, 'assetCode', 'code') ?? asset['code']),
    assetName: stringValue(pick(source, 'assetName', 'name') ?? asset['name']),
    towerCode: stringValue(pick(source, 'towerCode', 'tower') ?? asset['towerCode']),
    sequence: sequenceValue === undefined || sequenceValue === null ? null : numberValue(sequenceValue) || index + 1,
    inspectionStatus: stringValue(pick(source, 'inspectionStatus', 'status'), 'Pending'),
    latitude: latVal !== undefined && latVal !== null ? numberValue(latVal) : undefined,
    longitude: lngVal !== undefined && lngVal !== null ? numberValue(lngVal) : undefined,
  };
}) : [];
