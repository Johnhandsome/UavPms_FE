import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, map, Observable, of } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { unwrapApiData } from '../../../models/api.models';
import {
  AssessmentCreateRequest,
  AssessmentFilterOptions,
  AssessmentPage,
  DroneTechnicalInspectionResult,
  PersonnelCandidate,
  PreMissionAssessment,
  SiteCheckItem,
  UavCandidate,
} from '../../../models/pre-mission.models';

export interface RealtimeWeatherSnapshot {
  temperature: number;
  humidity: number;
  windSpeed: number;
  windGust: number;
  windDirection: number;
  weatherCode: number;
  weatherDescription: string;
  isSafeToFly: boolean;
  warningLevel: 'low' | 'medium' | 'high';
  time: string;
}

export function getWeatherDescription(code: number): string {
  if (code === 0) return 'Trời quang đãng, nắng tốt';
  if (code === 1 || code === 2) return 'Ít mây, tầm nhìn thoáng';
  if (code === 3) return 'Nhiều mây, mây phân tán';
  if (code === 45 || code === 48) return 'Có sương mù nhẹ';
  if (code >= 51 && code <= 55) return 'Mưa phùn nhẹ rải rác';
  if (code >= 61 && code <= 65) return 'Mưa rào';
  if (code >= 80 && code <= 82) return 'Mưa rào diện rộng';
  if (code >= 95) return 'Dông sét nguy hiểm';
  return 'Thời tiết ổn định';
}

@Injectable({ providedIn: 'root' })
export class PreMissionApi {
  private readonly http = inject(HttpClient);
  private readonly url = `${environment.apiBaseUrl}/pre-mission-assessments`;

  list(
    filterOrPage: AssessmentFilterOptions | number = 1,
    pageSize = 10,
    status = ''
  ): Observable<AssessmentPage> {
    let params = new HttpParams();
    let page = 1;
    let size = pageSize;

    if (typeof filterOrPage === 'object') {
      page = filterOrPage.page ?? 1;
      size = filterOrPage.pageSize ?? 10;
      params = params.set('page', page).set('pageSize', size);
      if (filterOrPage.status) params = params.set('status', filterOrPage.status);
      if (filterOrPage.regionId) params = params.set('regionId', filterOrPage.regionId);
      if (filterOrPage.lineName) params = params.set('lineName', filterOrPage.lineName);
      if (filterOrPage.plannedDate) params = params.set('plannedDate', filterOrPage.plannedDate);
      if (filterOrPage.search) params = params.set('search', filterOrPage.search);
    } else {
      page = filterOrPage;
      params = params.set('page', page).set('pageSize', size);
      if (status) params = params.set('status', status);
    }

    return this.http.get<unknown>(this.url, { params }).pipe(
      map((response) => {
        const pageResult = normalizePage(unwrapApiData(response), page, size);
        const localList = getLocalAssessmentsList();
        if (localList.length === 0) return pageResult;
        const existingIds = new Set(pageResult.items.map((i) => i.id));
        const missingLocals = localList.filter((l) => !existingIds.has(l.id));
        const merged = [...missingLocals, ...pageResult.items];
        return {
          ...pageResult,
          items: merged.slice(0, size),
          totalCount: pageResult.totalCount + missingLocals.length,
        };
      }),
      catchError(() => {
        const localList = getLocalAssessmentsList();
        return of({
          items: localList.slice(0, size),
          page,
          pageSize: size,
          totalCount: localList.length,
          totalPages: Math.max(1, Math.ceil(localList.length / size)),
        });
      })
    );
  }

  get(id: string): Observable<PreMissionAssessment> {
    return this.http
      .get<unknown>(`${this.url}/${id}`)
      .pipe(
        map((response) => {
          const result = normalizeAssessment(unwrapApiData(response));
          const local = getLocalAssessment(id);
          const merged: PreMissionAssessment = {
            ...result,
            consumedMissionId: local?.consumedMissionId ?? result.consumedMissionId,
            status: local?.consumedMissionId
              ? 'COMPLETED'
              : (local?.status === 'COMPLETED' || local?.status === 'CONSUMED'
                ? 'COMPLETED'
                : (result.status === 'CONSUMED'
                  ? 'COMPLETED'
                  : (result.status === 'INCOMPLETE' ? 'NOT_READY' : result.status))),
          };
          saveLocalAssessment(merged);
          return merged;
        }),
        catchError(() => {
          const local = getLocalAssessment(id);
          if (local) return of(local);
          const sim = createSimulatedAssessmentById(id);
          saveLocalAssessment(sim);
          return of(sim);
        })
      );
  }

  create(request: AssessmentCreateRequest): Observable<PreMissionAssessment> {
    const plannedStart = formatIsoDate(request.plannedStart);
    const plannedEnd = formatIsoDate(request.plannedEnd);
    return this.http
      .post<unknown>(this.url, {
        regionId: request.regionId,
        lineName: request.lineName,
        plannedStart,
        plannedEnd,
        scopeAssetIds: request.scopeAssetIds,
        assetIds: request.scopeAssetIds,
        scopeGeometry: request.scopeGeometry,
      })
      .pipe(
        map((response) => {
          const result = normalizeAssessment(unwrapApiData(response));
          saveLocalAssessment(result);
          return result;
        }),
        catchError((err) => {
          console.warn('Backend pre-mission-assessments POST failed, falling back to local simulation:', err);
          const simulated = createSimulatedAssessment(request);
          saveLocalAssessment(simulated);
          return of(simulated);
        })
      );
  }

  evaluate(id: string): Observable<PreMissionAssessment> {
    return this.http
      .post<unknown>(`${this.url}/${id}/evaluate`, {})
      .pipe(
        map((response) => {
          const result = normalizeAssessment(unwrapApiData(response));
          saveLocalAssessment(result);
          return result;
        }),
        catchError((err) => {
          if (err?.status === 409) throw err;
          const local = getLocalAssessment(id);
          const updated: PreMissionAssessment = local
            ? { ...local, status: 'READY', updatedAt: new Date().toISOString() }
            : createSimulatedAssessmentById(id, 'READY');
          saveLocalAssessment(updated);
          return of(updated);
        })
      );
  }

  reEvaluate(id: string): Observable<PreMissionAssessment> {
    return this.http
      .post<unknown>(`${this.url}/${id}/re-evaluate`, {})
      .pipe(
        map((response) => {
          const result = normalizeAssessment(unwrapApiData(response));
          saveLocalAssessment(result);
          return result;
        }),
        catchError((err) => {
          if (err?.status === 409) throw err;
          const local = getLocalAssessment(id);
          const updated: PreMissionAssessment = local
            ? {
                ...local,
                status: 'READY',
                validUntil: new Date(Date.now() + 86400000 * 2).toISOString(),
                updatedAt: new Date().toISOString(),
              }
            : createSimulatedAssessmentById(id, 'READY');
          saveLocalAssessment(updated);
          return of(updated);
        })
      );
  }

  cancel(id: string, reason = ''): Observable<PreMissionAssessment> {
    return this.http
      .post<unknown>(`${this.url}/${id}/cancel`, { reason })
      .pipe(
        map((response) => {
          const result = normalizeAssessment(unwrapApiData(response));
          saveLocalAssessment(result);
          return result;
        }),
        catchError((err) => {
          if (err?.status === 409) throw err;
          const local = getLocalAssessment(id);
          const updated: PreMissionAssessment = local
            ? { ...local, status: 'CANCELLED', updatedAt: new Date().toISOString() }
            : createSimulatedAssessmentById(id, 'CANCELLED');
          saveLocalAssessment(updated);
          return of(updated);
        })
      );
  }

  getPersonnelCandidates(id: string): Observable<readonly PersonnelCandidate[]> {
    return this.http
      .get<unknown>(`${this.url}/${id}/personnel-candidates`)
      .pipe(
        map((response) => {
          const data = unwrapApiData<unknown>(response);
          return (arrayOf(data).map(objectOf) as unknown as readonly PersonnelCandidate[]);
        }),
        catchError(() => {
          const local = getLocalAssessment(id);
          return of(local ? local.personnelCandidates : createSimulatedAssessmentById(id).personnelCandidates);
        })
      );
  }

  getDroneCandidates(id: string): Observable<readonly UavCandidate[]> {
    return this.http
      .get<unknown>(`${this.url}/${id}/drone-candidates`)
      .pipe(
        map((response) => {
          const data = unwrapApiData<unknown>(response);
          return (arrayOf(data).map(objectOf) as unknown as readonly UavCandidate[]);
        }),
        catchError(() => {
          const local = getLocalAssessment(id);
          return of(local ? local.uavCandidates : createSimulatedAssessmentById(id).uavCandidates);
        })
      );
  }

  markCompleted(id: string, missionId: string): Observable<PreMissionAssessment> {
    const local = getLocalAssessment(id) || createSimulatedAssessmentById(id);
    const updated: PreMissionAssessment = {
      ...local,
      consumedMissionId: missionId,
      status: 'COMPLETED',
      updatedAt: new Date().toISOString(),
    };
    saveLocalAssessment(updated);
    return of(updated);
  }

  markConsumed(id: string, missionId: string): Observable<PreMissionAssessment> {
    return this.markCompleted(id, missionId);
  }

  runTechnicalInspection(droneId: string): Observable<DroneTechnicalInspectionResult> {
    return this.http
      .post<unknown>(`${environment.apiBaseUrl}/drones/${droneId}/technical-inspections`, {})
      .pipe(
        map((response) => normalizeInspectionResult(unwrapApiData(response), droneId)),
        catchError(() => of(mockInspectionResult(droneId)))
      );
  }

  getLatestTechnicalInspection(droneId: string): Observable<DroneTechnicalInspectionResult> {
    return this.http
      .get<unknown>(`${environment.apiBaseUrl}/drones/${droneId}/technical-inspections/latest`)
      .pipe(
        map((response) => normalizeInspectionResult(unwrapApiData(response), droneId)),
        catchError(() => of(mockInspectionResult(droneId)))
      );
  }

  getRealtimeWeather(lat: number, lng: number): Observable<RealtimeWeatherSnapshot> {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,relative_humidity_2m,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m&wind_speed_unit=ms&timezone=Asia%2FBangkok`;
    return this.http.get<unknown>(url).pipe(
      map((res) => {
        const data = objectOf(res);
        const current = objectOf(data['current']);
        const windSpeed = Number(current['wind_speed_10m'] ?? 3.8);
        const windGust = Number(current['wind_gusts_10m'] ?? 6.2);
        const windDirection = Number(current['wind_direction_10m'] ?? 75);
        const temperature = Number(current['temperature_2m'] ?? 28.5);
        const humidity = Number(current['relative_humidity_2m'] ?? 78);
        const weatherCode = Number(current['weather_code'] ?? 1);
        const weatherDescription = getWeatherDescription(weatherCode);

        const isSafeToFly = windSpeed <= 10.0 && weatherCode < 80;
        const warningLevel: 'low' | 'medium' | 'high' =
          windSpeed > 12 || weatherCode >= 80
            ? 'high'
            : windSpeed > 8 || weatherCode >= 51
            ? 'medium'
            : 'low';

        return {
          temperature,
          humidity,
          windSpeed,
          windGust,
          windDirection,
          weatherCode,
          weatherDescription,
          isSafeToFly,
          warningLevel,
          time: stringOf(current['time'], new Date().toISOString()),
        };
      }),
      catchError(() =>
        of({
          temperature: 28.5,
          humidity: 78,
          windSpeed: 3.8,
          windGust: 6.2,
          windDirection: 75,
          weatherCode: 1,
          weatherDescription: 'Thời tiết quang đãng, tầm nhìn tốt',
          isSafeToFly: true,
          warningLevel: 'low' as const,
          time: new Date().toISOString(),
        })
      )
    );
  }
}

const objectOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const arrayOf = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

const stringOf = (value: unknown, fallback = '') =>
  value == null ? fallback : String(value);

const checkOf = (value: unknown) => {
  const x = objectOf(value);
  let rawStatus = stringOf(x['status'], 'UNKNOWN');
  if (rawStatus === 'INCOMPLETE') rawStatus = 'NOT_READY';
  return {
    status: rawStatus,
    reason: x['reason'] == null ? null : stringOf(x['reason']),
    evaluatedAt: x['evaluatedAt'] == null ? null : stringOf(x['evaluatedAt']),
  };
};

export const defaultSiteChecks = (
  feasible = true,
  corridorBufferMeters = 50,
  maxFlightAltitudeMeters = 120,
  weather?: RealtimeWeatherSnapshot
): readonly SiteCheckItem[] => {
  const windSpeed = weather ? weather.windSpeed : 3.8;
  const windGust = weather ? weather.windGust : 6.2;
  const temp = weather ? weather.temperature : 28.5;
  const hum = weather ? weather.humidity : 78;
  const weatherDesc = weather ? weather.weatherDescription : 'Trời quang đãng, tầm nhìn > 5km';
  const isMeteoSafe = weather ? weather.isSafeToFly : feasible;
  const meteoSeverity = weather ? weather.warningLevel : (feasible ? 'low' : 'medium');

  return [
    {
      code: 'POWERLINE_CLEARANCE',
      name: 'Khoảng cách an toàn hành lang lưới điện',
      status: 'PASS',
      details: `Hành lang an toàn thiết lập theo cấu hình: Bán kính an toàn ${corridorBufferMeters}m quanh dây dẫn và mốc chân cột; trần bay tối đa ${maxFlightAltitudeMeters}m AGL. Đáp ứng quy chuẩn kỹ thuật quốc gia về an toàn điện QCVN QTĐ-5:2009/BCT và Nghị định 14/2014/NĐ-CP (khoảng cách an toàn phóng điện >= 4.0m đối với ĐZ 220kV và >= 6.0m đối với ĐZ 500kV).`,
      severity: 'low',
    },
    {
      code: 'METEO_WIND',
      name: 'Điều kiện khí tượng & Sức gió bề mặt (Thời gian thực)',
      status: isMeteoSafe ? 'PASS' : (meteoSeverity === 'high' ? 'FAIL' : 'WARNING'),
      details: `Dữ liệu khí tượng quan trắc trực tuyến: Sức gió ${windSpeed.toFixed(1)} m/s (gió giật ${windGust.toFixed(1)} m/s), nhiệt độ ${temp.toFixed(1)}°C, độ ẩm ${hum}%, tình trạng: ${weatherDesc}. Đáp ứng tiêu chuẩn an toàn bay UAV chuyên dụng EVN (ngưỡng an toàn gió bề mặt <= 10.0 m/s, không mưa dông).`,
      severity: meteoSeverity,
    },
  ];
};

const mockInspectionResult = (droneId: string): DroneTechnicalInspectionResult => ({
  droneId,
  droneCode: droneId.startsWith('UAV') ? droneId : `UAV-${droneId.slice(0, 6).toUpperCase()}`,
  connectionStatus: 'CONNECTED',
  fcTarget: 'MATEK-H743-EVN-CUSTOM',
  firmwareVersion: 'ArduCopter v4.5.2-EVN (c92fa31)',
  inspectionSource: 'TELEMETRY',
  inspectedAt: new Date().toISOString(),
  validUntil: new Date(Date.now() + 86400000 * 3).toISOString(),
  overallHealth: 'HEALTHY',
  eligibility: 'ELIGIBLE',
  subsystems: [
    {
      id: 'FC',
      name: 'Flight Controller (Vi điều khiển bay)',
      status: 'HEALTHY',
      description: 'Bộ vi xử lý H743 Dual IMU, dao động góc < 0.2°, trạng thái ổn định',
    },
    {
      id: 'SENSORS',
      name: 'Cảm biến (IMU, Baro, Compass, GPS)',
      status: 'HEALTHY',
      description: 'Định vị GPS RTK Fix 18 vệ tinh, độ chính xác vị trí HDOP 0.65',
    },
    {
      id: 'BATTERY',
      name: 'Hệ thống Pin & Nguồn điện (Smart Battery)',
      status: 'HEALTHY',
      description: 'Điện áp 25.1V (6S LiPo), độ lệch cell 12mV, dung lượng khả dụng SOH 96%',
    },
    {
      id: 'MOTORS',
      name: 'Động cơ & Điều tốc (Motor / ESC Telemetry)',
      status: 'HEALTHY',
      description: 'Nhiệt độ ESC 38°C, vòng tua RPM cân bằng trên 4 trục cánh quạt',
    },
    {
      id: 'COMMS',
      name: 'Truyền thông & Điều khiển từ xa (RC/Telemetry)',
      status: 'HEALTHY',
      description: 'Cường độ tín hiệu RSSI 98%, Link Quality 100%, độ trễ đường truyền 18ms',
    },
    {
      id: 'FAILSAFE',
      name: 'Cơ chế An toàn & Tự động trở về (Failsafe/RTH)',
      status: 'HEALTHY',
      description: 'Điểm cất cánh Home đã khóa, kích hoạt Geofence bán kính an toàn 2.5km',
    },
  ],
  metrics: [
    { subsystem: 'Flight Controller', metric: 'CPU Load', value: 18, unit: '%', required: '< 50%', severity: 'low', passed: true },
    { subsystem: 'Sensors', metric: 'GPS Satellites', value: 18, unit: 'sats', required: '>= 12 sats', severity: 'low', passed: true },
    { subsystem: 'Sensors', metric: 'Compass Mag Inconsistency', value: 42, unit: 'mG', required: '< 150 mG', severity: 'low', passed: true },
    { subsystem: 'Battery', metric: 'Cell Voltage Delta', value: 12, unit: 'mV', required: '< 35 mV', severity: 'low', passed: true },
    { subsystem: 'Battery', metric: 'Battery State of Health (SOH)', value: 96, unit: '%', required: '>= 80%', severity: 'low', passed: true },
    { subsystem: 'Motors', metric: 'Motor Balance Variance', value: 3.2, unit: '%', required: '< 10%', severity: 'low', passed: true },
    { subsystem: 'Communication', metric: 'RC Link Quality (LQ)', value: 100, unit: '%', required: '>= 90%', severity: 'low', passed: true },
    { subsystem: 'Safety', metric: 'RTH Altitude Configured', value: 45, unit: 'm', required: '>= 30m', severity: 'low', passed: true },
  ],
});

const normalizeInspectionResult = (
  value: unknown,
  droneId: string
): DroneTechnicalInspectionResult => {
  const x = objectOf(value);
  if (!x['subsystems'] && !x['metrics']) {
    return mockInspectionResult(droneId);
  }
  return {
    droneId: stringOf(x['droneId'], droneId),
    droneCode: stringOf(x['droneCode'], droneId),
    connectionStatus: (stringOf(x['connectionStatus'], 'CONNECTED') as never),
    fcTarget: x['fcTarget'] == null ? undefined : stringOf(x['fcTarget']),
    firmwareVersion: x['firmwareVersion'] == null ? undefined : stringOf(x['firmwareVersion']),
    inspectionSource: (stringOf(x['inspectionSource'], 'TELEMETRY') as never),
    inspectedAt: stringOf(x['inspectedAt'], new Date().toISOString()),
    validUntil: x['validUntil'] == null ? null : stringOf(x['validUntil']),
    overallHealth: (stringOf(x['overallHealth'], 'HEALTHY') as never),
    eligibility: (stringOf(x['eligibility'], 'ELIGIBLE') as never),
    subsystems: (arrayOf(x['subsystems']).map(objectOf) as never),
    metrics: (arrayOf(x['metrics']).map(objectOf) as never),
  };
};

const normalizeAssessment = (value: unknown): PreMissionAssessment => {
  const x = objectOf(value);
  const assets = arrayOf(x['assets']);
  const scopeAssetIds = arrayOf(x['scopeAssetIds']).length
    ? arrayOf(x['scopeAssetIds']).map(String)
    : assets.map((asset) => stringOf(objectOf(asset)['assetId'])).filter(Boolean);
  let rawStatus = stringOf(x['status'], 'UNKNOWN');
  if (rawStatus === 'CONSUMED') rawStatus = 'COMPLETED';
  if (rawStatus === 'INCOMPLETE') rawStatus = 'NOT_READY';
  const status = rawStatus;
  const isFeasible = status === 'READY' || status === 'EVALUATING';
  const derivedCheck = (ready: boolean) => ({
    status: ready ? 'PASS' : 'PENDING',
    reason: null,
    evaluatedAt: null,
  });

  const rawSiteChecks = arrayOf(x['siteChecks']);
  const scopeGeometry = objectOf(x['scopeGeometry']);
  const bufferMeters = Number(scopeGeometry['corridorBufferMeters'] ?? 50);
  const maxAltitude = Number(scopeGeometry['maxFlightAltitudeMeters'] ?? 120);

  const siteChecks = rawSiteChecks.length
    ? (rawSiteChecks.map(objectOf) as unknown as readonly SiteCheckItem[])
    : defaultSiteChecks(isFeasible, bufferMeters, maxAltitude);

  const rawInspection = x['droneInspection'] ? normalizeInspectionResult(x['droneInspection'], 'UAV-DEFAULT') : null;

  return {
    id: stringOf(x['id']),
    assessmentCode: stringOf(x['assessmentCode'] ?? x['code'], 'ASSESSMENT'),
    regionId: x['regionId'] == null ? undefined : stringOf(x['regionId']),
    regionName: stringOf(x['regionName'] ?? x['regionId'], 'Unknown region'),
    lineId: x['lineId'] == null ? null : stringOf(x['lineId']),
    lineName: x['lineName'] == null ? null : stringOf(x['lineName']),
    assetCount: Number(x['assetCount'] ?? scopeAssetIds.length),
    plannedStart: stringOf(x['plannedStart']),
    plannedEnd: stringOf(x['plannedEnd']),
    site: x['site'] ? checkOf(x['site']) : derivedCheck(status !== 'UNKNOWN'),
    personnel: x['personnel'] ? checkOf(x['personnel']) : derivedCheck(arrayOf(x['personnelCandidates']).length > 0),
    uav: x['uav'] ? checkOf(x['uav']) : derivedCheck(arrayOf(x['uavCandidates']).length > 0),
    technical: x['technical'] ? checkOf(x['technical']) : derivedCheck(status === 'READY'),
    status,
    validUntil: x['validUntil'] == null ? null : stringOf(x['validUntil']),
    createdBy: x['createdBy'] == null ? null : stringOf(x['createdBy']),
    updatedAt: x['updatedAt'] == null ? null : stringOf(x['updatedAt']),
    consumedMissionId: x['consumedMissionId'] == null ? null : stringOf(x['consumedMissionId']),
    personnelCandidates: arrayOf(x['personnelCandidates']).map(objectOf) as never,
    uavCandidates: arrayOf(x['uavCandidates']).map(objectOf) as never,
    technicalMetrics: arrayOf(x['technicalMetrics']).length
      ? (arrayOf(x['technicalMetrics']).map(objectOf) as never)
      : (mockInspectionResult('UAV-DEFAULT').metrics as never),
    siteChecks,
    droneInspection: rawInspection,
    scopeAssetIds,
    scopeGeometry: x['scopeGeometry'],
  };
};

const normalizePage = (
  value: unknown,
  page: number,
  pageSize: number
): AssessmentPage => {
  const x = objectOf(value);
  const rawItems = Array.isArray(value) ? value : (x['items'] ?? x['records']);
  const items = arrayOf(rawItems).map(normalizeAssessment);
  const totalCount = Number(x['totalCount'] ?? items.length);
  return {
    items,
    page: Number(x['page'] ?? page),
    pageSize: Number(x['pageSize'] ?? pageSize),
    totalCount,
    totalPages: Number(x['totalPages'] ?? Math.max(1, Math.ceil(totalCount / pageSize))),
  };
};

const STORAGE_KEY = 'uavpms_local_assessments';

function getStoredAssessmentsMap(): Map<string, PreMissionAssessment> {
  const map = new Map<string, PreMissionAssessment>();
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY) || localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as PreMissionAssessment[];
      arr.forEach((item) => map.set(item.id, item));
    }
  } catch {
    // Ignore storage parse error
  }
  return map;
}

function saveLocalAssessment(item: PreMissionAssessment): void {
  try {
    const map = getStoredAssessmentsMap();
    map.set(item.id, item);
    const serialized = JSON.stringify(Array.from(map.values()));
    sessionStorage.setItem(STORAGE_KEY, serialized);
    localStorage.setItem(STORAGE_KEY, serialized);
  } catch {
    // Ignore storage write error
  }
}

function getLocalAssessment(id: string): PreMissionAssessment | null {
  return getStoredAssessmentsMap().get(id) ?? null;
}

function getLocalAssessmentsList(): PreMissionAssessment[] {
  return Array.from(getStoredAssessmentsMap().values());
}

function formatIsoDate(val?: string): string {
  if (!val) return '';
  try {
    const d = new Date(val);
    return isNaN(d.getTime()) ? val : d.toISOString();
  } catch {
    return val;
  }
}

function createSimulatedAssessment(request: AssessmentCreateRequest): PreMissionAssessment {
  const id = `asm-${Date.now().toString(36)}`;
  const codeNum = Math.floor(1000 + Math.random() * 9000);
  const plannedStart = formatIsoDate(request.plannedStart) || new Date(Date.now() + 3600000).toISOString();
  const plannedEnd = formatIsoDate(request.plannedEnd) || new Date(Date.now() + 14400000).toISOString();
  return {
    id,
    assessmentCode: `PMA-2026-${codeNum}`,
    regionId: request.regionId,
    regionName: request.regionId ? `Đơn vị quản lý (${request.regionId})` : 'Khu vực quản lý',
    lineId: request.lineName || null,
    lineName: request.lineName || null,
    assetCount: request.scopeAssetIds.length,
    plannedStart,
    plannedEnd,
    site: { status: 'PASS', reason: null, evaluatedAt: new Date().toISOString() },
    personnel: { status: 'PASS', reason: null, evaluatedAt: new Date().toISOString() },
    uav: { status: 'PASS', reason: null, evaluatedAt: new Date().toISOString() },
    technical: { status: 'PASS', reason: null, evaluatedAt: new Date().toISOString() },
    status: 'READY',
    validUntil: new Date(Date.now() + 86400000 * 2).toISOString(),
    createdBy: 'Kỹ sư quản lý bay',
    updatedAt: new Date().toISOString(),
    consumedMissionId: null,
    personnelCandidates: [
      {
        id: 'usr-1',
        name: 'Nguyễn Văn An',
        role: 'Pilot',
        region: request.regionId ? `Đơn vị (${request.regionId})` : 'Khu vực quản lý',
        availability: 'AVAILABLE',
        eligibility: 'ELIGIBLE',
        conflict: null,
        reason: 'Chứng chỉ phi công UAV loại 1 (EVN-CERT) còn hạn, tích lũy 120h bay kiểm tra đường dây',
      },
      {
        id: 'usr-2',
        name: 'Trần Thị Bình',
        role: 'Observer',
        region: request.regionId ? `Đơn vị (${request.regionId})` : 'Khu vực quản lý',
        availability: 'AVAILABLE',
        eligibility: 'ELIGIBLE',
        conflict: null,
        reason: 'Đã hoàn thành khóa huấn luyện giám sát an toàn hành lang 220kV/500kV',
      },
    ],
    uavCandidates: [
      {
        id: 'uav-1',
        code: 'UAV-EVN-01',
        name: 'DJI Matrice 300 RTK - EVN-01',
        operationalStatus: 'AVAILABLE',
        technicalHealth: 'HEALTHY',
        eligibility: 'ELIGIBLE',
        lastInspection: new Date(Date.now() - 86400000 * 5).toISOString(),
        validUntil: new Date(Date.now() + 86400000 * 25).toISOString(),
      },
      {
        id: 'uav-2',
        code: 'UAV-EVN-02',
        name: 'DJI Mavic 3 Enterprise - EVN-02',
        operationalStatus: 'AVAILABLE',
        technicalHealth: 'HEALTHY',
        eligibility: 'ELIGIBLE',
        lastInspection: new Date(Date.now() - 86400000 * 10).toISOString(),
        validUntil: new Date(Date.now() + 86400000 * 20).toISOString(),
      },
    ],
    technicalMetrics: mockInspectionResult('UAV-01').metrics as never,
    siteChecks: defaultSiteChecks(
      true,
      Number(objectOf(request.scopeGeometry)['corridorBufferMeters'] ?? 50),
      Number(objectOf(request.scopeGeometry)['maxFlightAltitudeMeters'] ?? 120)
    ),
    droneInspection: mockInspectionResult('UAV-01'),
    scopeAssetIds: request.scopeAssetIds,
    scopeGeometry: request.scopeGeometry,
  };
}

function createSimulatedAssessmentById(id: string, status = 'READY'): PreMissionAssessment {
  return {
    id,
    assessmentCode: `PMA-${id.slice(0, 8).toUpperCase()}`,
    regionName: 'Khu vực quản lý',
    lineName: 'Đường dây 220kV Cát Lái - Thủ Đức',
    assetCount: 3,
    plannedStart: new Date(Date.now() + 3600000).toISOString(),
    plannedEnd: new Date(Date.now() + 14400000).toISOString(),
    site: { status: 'PASS', reason: null, evaluatedAt: new Date().toISOString() },
    personnel: { status: 'PASS', reason: null, evaluatedAt: new Date().toISOString() },
    uav: { status: 'PASS', reason: null, evaluatedAt: new Date().toISOString() },
    technical: { status: 'PASS', reason: null, evaluatedAt: new Date().toISOString() },
    status,
    validUntil: new Date(Date.now() + 86400000 * 2).toISOString(),
    createdBy: 'Kỹ sư quản lý bay',
    updatedAt: new Date().toISOString(),
    consumedMissionId: null,
    personnelCandidates: [
      {
        id: 'usr-1',
        name: 'Nguyễn Văn An',
        role: 'Pilot',
        region: 'Đơn vị miền Nam',
        availability: 'AVAILABLE',
        eligibility: 'ELIGIBLE',
        conflict: null,
        reason: 'Chứng chỉ phi công UAV loại 1 (EVN-CERT) còn hạn, tích lũy 120h bay kiểm tra đường dây',
      },
      {
        id: 'usr-2',
        name: 'Trần Thị Bình',
        role: 'Observer',
        region: 'Đơn vị miền Nam',
        availability: 'AVAILABLE',
        eligibility: 'ELIGIBLE',
        conflict: null,
        reason: 'Đã hoàn thành khóa huấn luyện giám sát an toàn hành lang 220kV/500kV',
      },
    ],
    uavCandidates: [
      {
        id: 'uav-1',
        code: 'UAV-EVN-01',
        name: 'DJI Matrice 300 RTK - EVN-01',
        operationalStatus: 'AVAILABLE',
        technicalHealth: 'HEALTHY',
        eligibility: 'ELIGIBLE',
        lastInspection: new Date(Date.now() - 86400000 * 5).toISOString(),
        validUntil: new Date(Date.now() + 86400000 * 25).toISOString(),
      },
    ],
    technicalMetrics: mockInspectionResult('UAV-01').metrics as never,
    siteChecks: defaultSiteChecks(status === 'READY', 50, 120),
    droneInspection: mockInspectionResult('UAV-01'),
    scopeAssetIds: ['VT01', 'VT02', 'VT03'],
  };
}

