import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, map, Observable, of, switchMap } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { unwrapApiData } from '../../../models/api.models';
import { UserRecord } from '../../../models/users.models';
import { UsersApi } from '../../users/data-access/users-api';
import {
  AssessmentCreateRequest,
  AssessmentFilterOptions,
  AssessmentPage,
  AssessmentStatus,
  DroneTechnicalInspectionResult,
  PersonnelCandidate,
  PreMissionAssessment,
  ReadinessCheck,
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
  private readonly usersApi = inject(UsersApi);
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
    return this.usersApi.getAll().pipe(
      catchError(() => of([] as readonly UserRecord[])),
      switchMap((users) => {
        return this.http
          .get<unknown>(`${this.url}/${id}`)
          .pipe(
            map((response) => {
              const result = normalizeAssessment(unwrapApiData(response));
              const local = getLocalAssessment(id);
              const candidates = (users && users.length > 0)
                ? buildCandidatesFromUsers(users, result.regionId)
                : ((result.personnelCandidates && result.personnelCandidates.length > 0)
                  ? result.personnelCandidates
                  : (local?.personnelCandidates || getDefaultFallbackPersonnel(result.regionId)));

              const reqInsp = local?.requiredInspectors ?? result.requiredInspectors ?? 1;
              const reqAna = local?.requiredAnalysts ?? result.requiredAnalysts ?? 1;
              const reqTech = local?.requiredTechnicians ?? result.requiredTechnicians ?? 1;

              const evaluatedPersonnel = derivedPersonnelCheck(candidates as any, reqInsp, reqAna, reqTech);

              const merged: PreMissionAssessment = {
                ...result,
                requiredInspectors: reqInsp,
                requiredAnalysts: reqAna,
                requiredTechnicians: reqTech,
                personnelCandidates: candidates,
                personnel: evaluatedPersonnel,
                consumedMissionId: local?.consumedMissionId ?? result.consumedMissionId,
                status: local?.consumedMissionId
                  ? 'COMPLETED'
                  : (local?.status === 'COMPLETED' || local?.status === 'CONSUMED'
                    ? 'COMPLETED'
                    : (evaluatedPersonnel.status === 'FAIL' ? 'NOT_READY' : (result.status === 'CONSUMED' ? 'COMPLETED' : (result.status === 'INCOMPLETE' ? 'NOT_READY' : result.status)))),
              };
              saveLocalAssessment(merged);
              return merged;
            }),
            catchError(() => {
              const local = getLocalAssessment(id);
              if (local) {
                const candidates = (users && users.length > 0)
                  ? buildCandidatesFromUsers(users, local.regionId)
                  : local.personnelCandidates;
                const reqInsp = local.requiredInspectors ?? 1;
                const reqAna = local.requiredAnalysts ?? 1;
                const reqTech = local.requiredTechnicians ?? 1;
                const evaluatedPersonnel = derivedPersonnelCheck(candidates as any, reqInsp, reqAna, reqTech);
                const updated = {
                  ...local,
                  personnelCandidates: candidates,
                  personnel: evaluatedPersonnel,
                  status: evaluatedPersonnel.status === 'FAIL' ? 'NOT_READY' : local.status,
                };
                saveLocalAssessment(updated);
                return of(updated);
              }
              const candidates = (users && users.length > 0)
                ? buildCandidatesFromUsers(users)
                : getDefaultFallbackPersonnel();
              const sim = createSimulatedAssessmentById(id, undefined, candidates);
              saveLocalAssessment(sim);
              return of(sim);
            })
          );
      })
    );
  }

  create(request: AssessmentCreateRequest): Observable<PreMissionAssessment> {
    const plannedStart = formatIsoDate(request.plannedStart);
    const plannedEnd = formatIsoDate(request.plannedEnd);

    return this.usersApi.getAll().pipe(
      catchError(() => of([] as readonly UserRecord[])),
      switchMap((users) => {
        const personnelCandidates = (users && users.length > 0)
          ? buildCandidatesFromUsers(users, request.regionId)
          : getDefaultFallbackPersonnel(request.regionId);

        return this.http
          .post<unknown>(this.url, {
            regionId: request.regionId,
            lineName: request.lineName,
            plannedStart,
            plannedEnd,
            scopeAssetIds: request.scopeAssetIds,
            assetIds: request.scopeAssetIds,
            requiredInspectors: request.requiredInspectors ?? 1,
            requiredAnalysts: request.requiredAnalysts ?? 1,
            requiredTechnicians: request.requiredTechnicians ?? 1,
            scopeGeometry: {
              ...(typeof request.scopeGeometry === 'object' ? request.scopeGeometry : {}),
              requiredInspectors: request.requiredInspectors ?? 1,
              requiredAnalysts: request.requiredAnalysts ?? 1,
              requiredTechnicians: request.requiredTechnicians ?? 1,
            },
          })
          .pipe(
            map((response) => {
              const result = normalizeAssessment(unwrapApiData(response));
              const reqInsp = request.requiredInspectors ?? result.requiredInspectors ?? 1;
              const reqAna = request.requiredAnalysts ?? result.requiredAnalysts ?? 1;
              const reqTech = request.requiredTechnicians ?? result.requiredTechnicians ?? 1;
              const candidates = (result.personnelCandidates && result.personnelCandidates.length > 0)
                ? result.personnelCandidates
                : personnelCandidates;

              const evaluatedPersonnel = derivedPersonnelCheck(candidates as any, reqInsp, reqAna, reqTech);
              const merged: PreMissionAssessment = {
                ...result,
                requiredInspectors: reqInsp,
                requiredAnalysts: reqAna,
                requiredTechnicians: reqTech,
                personnelCandidates: candidates,
                personnel: evaluatedPersonnel,
                status: evaluatedPersonnel.status === 'FAIL' ? 'NOT_READY' : result.status,
              };
              saveLocalAssessment(merged);
              return merged;
            }),
            catchError((err) => {
              console.warn('Backend pre-mission-assessments POST failed, falling back to local simulation:', err);
              const simulated = createSimulatedAssessment(request, personnelCandidates);
              saveLocalAssessment(simulated);
              return of(simulated);
            })
          );
      })
    );
  }

  updateQuotas(
    id: string,
    quotas: { requiredInspectors?: number; requiredAnalysts?: number; requiredTechnicians?: number }
  ): Observable<PreMissionAssessment> {
    const local = getLocalAssessment(id);
    if (!local) return of(createSimulatedAssessmentById(id));

    const reqInsp = quotas.requiredInspectors ?? local.requiredInspectors ?? 1;
    const reqAna = quotas.requiredAnalysts ?? local.requiredAnalysts ?? 1;
    const reqTech = quotas.requiredTechnicians ?? local.requiredTechnicians ?? 1;

    const evaluatedPersonnel = derivedPersonnelCheck(local.personnelCandidates as any, reqInsp, reqAna, reqTech);
    const updated: PreMissionAssessment = {
      ...local,
      requiredInspectors: reqInsp,
      requiredAnalysts: reqAna,
      requiredTechnicians: reqTech,
      personnel: evaluatedPersonnel,
      status: evaluatedPersonnel.status === 'FAIL'
        ? 'NOT_READY'
        : (local.status === 'NOT_READY' && evaluatedPersonnel.status === 'PASS' && local.site?.status === 'PASS' && local.uav?.status === 'PASS' ? 'READY' : local.status),
      updatedAt: new Date().toISOString(),
    };
    saveLocalAssessment(updated);
    return of(updated);
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

function getBusyUserIdsFromActiveMissions(): Set<string> {
  const busy = new Set<string>();
  try {
    const raw = localStorage.getItem('uav_pms_missions_data_v2') || sessionStorage.getItem('uav_pms_missions_data_v2');
    if (raw) {
      const map = JSON.parse(raw) as Record<string, unknown>;
      Object.values(map).forEach((item) => {
        const m = item as Record<string, unknown>;
        const s = stringOf(m?.['status']).toUpperCase();
        if (s && !['COMPLETED', 'CANCELLED', 'REJECTED'].includes(s)) {
          if (m['inspectorId']) busy.add(String(m['inspectorId']));
          if (m['analystId']) busy.add(String(m['analystId']));
          if (m['technicianId']) busy.add(String(m['technicianId']));
          if (Array.isArray(m['assignments'])) {
            m['assignments'].forEach((as: unknown) => {
              const a = as as Record<string, unknown>;
              if (a?.['userId'] && !['REJECTED', 'CANCELLED'].includes(stringOf(a?.['status']))) {
                busy.add(String(a['userId']));
              }
            });
          }
        }
      });
    }
  } catch {
    // Ignore storage parse error
  }
  return busy;
}

function buildCandidatesFromUsers(
  users: readonly UserRecord[],
  regionId?: string
): PersonnelCandidate[] {
  const busyUserIds = getBusyUserIdsFromActiveMissions();

  return users.map((u) => {
    const roleRaw = (u.role || '').toUpperCase();
    let role: 'INSPECTOR' | 'ANALYST' | 'TECHNICIAN' = 'INSPECTOR';
    let qual = 'Chứng chỉ phi công UAV loại 1 (EVN-CERT), >120h bay kiểm tra đường dây';
    if (roleRaw.includes('ANALYST') || roleRaw.includes('PHÂN TÍCH')) {
      role = 'ANALYST';
      qual = 'Chứng chỉ thẩm định khuyết tật lưới điện AI & xử lý ảnh quang học cấp 2';
    } else if (roleRaw.includes('TECH') || roleRaw.includes('KỸ THUẬT') || roleRaw.includes('BẢO TRÌ')) {
      role = 'TECHNICIAN';
      qual = 'Kỹ sư cơ điện tử, chứng chỉ kiểm định an toàn kỹ thuật UAV & trạm pin';
    } else {
      role = 'INSPECTOR';
      qual = 'Chứng chỉ phi công UAV loại 1 (EVN-CERT), >120h bay kiểm tra đường dây';
    }

    const isActive = u.status === 'Active';
    const isBusy = busyUserIds.has(u.id);
    const isAvailable = isActive && !isBusy;
    const isEligible = isActive;

    return {
      id: u.id,
      name: u.fullName || u.username || u.email,
      role,
      region: regionId ? `Đơn vị (${regionId})` : 'Khu vực quản lý',
      regionId,
      availability: isAvailable ? 'AVAILABLE' : 'BUSY',
      eligibility: isEligible ? 'ELIGIBLE' : 'INELIGIBLE',
      isActive,
      isEligible,
      isWithinScope: true,
      isAvailable,
      overallEligibility: isAvailable ? 'ELIGIBLE' : (isBusy ? 'BUSY' : 'INELIGIBLE'),
      qualificationDetails: qual,
      conflict: isBusy ? 'Đang thực hiện nhiệm vụ bay khác' : null,
      reason: isAvailable
        ? 'Đạt đầy đủ 5 tiêu chuẩn sẵn sàng vận hành bay (Đang rảnh)'
        : (isBusy ? 'Trùng lịch công tác / nhiệm vụ bay' : 'Tài khoản không hoạt động'),
    };
  });
}

function getDefaultFallbackPersonnel(regionId?: string): PersonnelCandidate[] {
  const reg = regionId ? `Đơn vị (${regionId})` : 'Khu vực quản lý';
  return [
    // Inspectors
    {
      id: 'usr-1',
      name: 'Nguyễn Văn An',
      role: 'INSPECTOR',
      region: reg,
      availability: 'AVAILABLE',
      eligibility: 'ELIGIBLE',
      isActive: true,
      isEligible: true,
      isWithinScope: true,
      isAvailable: true,
      overallEligibility: 'ELIGIBLE',
      qualificationDetails: 'Chứng chỉ phi công UAV loại 1 (EVN-CERT), 150h bay kiểm tra đường dây 220/500kV',
      conflict: null,
      reason: 'Đạt đầy đủ 5 tiêu chuẩn sẵn sàng vận hành bay (Đang rảnh)',
    },
    {
      id: 'usr-2',
      name: 'Trần Minh Tuấn',
      role: 'INSPECTOR',
      region: reg,
      availability: 'AVAILABLE',
      eligibility: 'ELIGIBLE',
      isActive: true,
      isEligible: true,
      isWithinScope: true,
      isAvailable: true,
      overallEligibility: 'ELIGIBLE',
      qualificationDetails: 'Chứng chỉ phi công UAV loại 1, chuyên gia bay tầm gần kiểm tra phụ kiện cách điện',
      conflict: null,
      reason: 'Đạt đầy đủ 5 tiêu chuẩn sẵn sàng vận hành bay (Đang rảnh)',
    },
    {
      id: 'usr-3',
      name: 'Hoàng Đức Trọng',
      role: 'INSPECTOR',
      region: reg,
      availability: 'AVAILABLE',
      eligibility: 'ELIGIBLE',
      isActive: true,
      isEligible: true,
      isWithinScope: true,
      isAvailable: true,
      overallEligibility: 'ELIGIBLE',
      qualificationDetails: 'Phi công UAV cấp cao, chứng chỉ điều khiển bay vượt địa hình hiểm trở',
      conflict: null,
      reason: 'Đạt đầy đủ 5 tiêu chuẩn sẵn sàng vận hành bay (Đang rảnh)',
    },
    {
      id: 'usr-4',
      name: 'Đỗ Hữu Nghĩa',
      role: 'INSPECTOR',
      region: reg,
      availability: 'AVAILABLE',
      eligibility: 'ELIGIBLE',
      isActive: true,
      isEligible: true,
      isWithinScope: true,
      isAvailable: true,
      overallEligibility: 'ELIGIBLE',
      qualificationDetails: 'Chứng chỉ phi công UAV thương mại EVN, kinh nghiệm 90h bay trinh sát sự cố',
      conflict: null,
      reason: 'Đạt đầy đủ 5 tiêu chuẩn sẵn sàng vận hành bay (Đang rảnh)',
    },
    {
      id: 'usr-5',
      name: 'Đặng Quang Huy',
      role: 'INSPECTOR',
      region: reg,
      availability: 'BUSY',
      eligibility: 'ELIGIBLE',
      isActive: true,
      isEligible: true,
      isWithinScope: true,
      isAvailable: false,
      overallEligibility: 'BUSY',
      qualificationDetails: 'Phi công UAV đường dây 500kV',
      conflict: 'Đang thực hiện bay kiểm tra sự cố tuyến ĐZ 500kV Nho Quan - Thường Tín',
      reason: 'Trùng lịch công tác / nhiệm vụ bay đang diễn ra',
    },

    // Analysts
    {
      id: 'usr-6',
      name: 'Lê Thị Mai',
      role: 'ANALYST',
      region: reg,
      availability: 'AVAILABLE',
      eligibility: 'ELIGIBLE',
      isActive: true,
      isEligible: true,
      isWithinScope: true,
      isAvailable: true,
      overallEligibility: 'ELIGIBLE',
      qualificationDetails: 'Chứng chỉ thẩm định khuyết tật lưới điện AI & xử lý ảnh quang học cấp 2',
      conflict: null,
      reason: 'Đạt đầy đủ 5 tiêu chuẩn sẵn sàng phân tích dữ liệu (Đang rảnh)',
    },
    {
      id: 'usr-7',
      name: 'Vũ Hồng Nhung',
      role: 'ANALYST',
      region: reg,
      availability: 'AVAILABLE',
      eligibility: 'ELIGIBLE',
      isActive: true,
      isEligible: true,
      isWithinScope: true,
      isAvailable: true,
      overallEligibility: 'ELIGIBLE',
      qualificationDetails: 'Chuyên viên xử lý dữ liệu viễn thám LiDAR & phân tích phát nhiệt mối nối',
      conflict: null,
      reason: 'Đạt đầy đủ 5 tiêu chuẩn sẵn sàng phân tích dữ liệu (Đang rảnh)',
    },
    {
      id: 'usr-8',
      name: 'Bùi Gia Huy',
      role: 'ANALYST',
      region: reg,
      availability: 'AVAILABLE',
      eligibility: 'ELIGIBLE',
      isActive: true,
      isEligible: true,
      isWithinScope: true,
      isAvailable: true,
      overallEligibility: 'ELIGIBLE',
      qualificationDetails: 'Kỹ sư phân tích dữ liệu thị giác máy tính & kiểm định khuyết tật chuỗi sứ',
      conflict: null,
      reason: 'Đạt đầy đủ 5 tiêu chuẩn sẵn sàng phân tích dữ liệu (Đang rảnh)',
    },
    {
      id: 'usr-9',
      name: 'Nguyễn Thanh Tùng',
      role: 'ANALYST',
      region: reg,
      availability: 'BUSY',
      eligibility: 'ELIGIBLE',
      isActive: true,
      isEligible: true,
      isWithinScope: true,
      isAvailable: false,
      overallEligibility: 'BUSY',
      qualificationDetails: 'Chuyên viên AI chẩn đoán ảnh nhiệt',
      conflict: 'Đang tham gia hội đồng giám định khuyết tật ảnh nhiệt trạm biến áp',
      reason: 'Đang bận công tác giám định chuyên đề',
    },

    // Technicians
    {
      id: 'usr-10',
      name: 'Phạm Quốc Toàn',
      role: 'TECHNICIAN',
      region: reg,
      availability: 'AVAILABLE',
      eligibility: 'ELIGIBLE',
      isActive: true,
      isEligible: true,
      isWithinScope: true,
      isAvailable: true,
      overallEligibility: 'ELIGIBLE',
      qualificationDetails: 'Kỹ sư cơ điện tử, chứng chỉ kiểm định an toàn kỹ thuật UAV & trạm pin thông minh',
      conflict: null,
      reason: 'Đạt đầy đủ 5 tiêu chuẩn sẵn sàng kỹ thuật thiết bị (Đang rảnh)',
    },
    {
      id: 'usr-11',
      name: 'Ngô Đức Duy',
      role: 'TECHNICIAN',
      region: reg,
      availability: 'AVAILABLE',
      eligibility: 'ELIGIBLE',
      isActive: true,
      isEligible: true,
      isWithinScope: true,
      isAvailable: true,
      overallEligibility: 'ELIGIBLE',
      qualificationDetails: 'Chứng chỉ bảo dưỡng phần cứng bay ArduPilot, kỹ thuật cân chỉnh gimbal & payload cảm biến',
      conflict: null,
      reason: 'Đạt đầy đủ 5 tiêu chuẩn sẵn sàng kỹ thuật thiết bị (Đang rảnh)',
    },
    {
      id: 'usr-12',
      name: 'Trịnh Văn Lâm',
      role: 'TECHNICIAN',
      region: reg,
      availability: 'AVAILABLE',
      eligibility: 'ELIGIBLE',
      isActive: true,
      isEligible: true,
      isWithinScope: true,
      isAvailable: true,
      overallEligibility: 'ELIGIBLE',
      qualificationDetails: 'Kỹ thuật viên điện - điện tử, chuyên trách trạm sạc dã chiến & kiểm tra xung lực cánh quạt',
      conflict: null,
      reason: 'Đạt đầy đủ 5 tiêu chuẩn sẵn sàng kỹ thuật thiết bị (Đang rảnh)',
    },
    {
      id: 'usr-13',
      name: 'Lương Minh Khoa',
      role: 'TECHNICIAN',
      region: reg,
      availability: 'AVAILABLE',
      eligibility: 'ELIGIBLE',
      isActive: true,
      isEligible: true,
      isWithinScope: true,
      isAvailable: true,
      overallEligibility: 'ELIGIBLE',
      qualificationDetails: 'Kỹ sư bảo trì thiết bị điện tử viễn thông, kiểm định liên lạc RC/Telemetry 4G',
      conflict: null,
      reason: 'Đạt đầy đủ 5 tiêu chuẩn sẵn sàng kỹ thuật thiết bị (Đang rảnh)',
    },
    {
      id: 'usr-14',
      name: 'Lê Bá Thành',
      role: 'TECHNICIAN',
      region: reg,
      availability: 'AVAILABLE',
      eligibility: 'ELIGIBLE',
      isActive: true,
      isEligible: true,
      isWithinScope: true,
      isAvailable: true,
      overallEligibility: 'ELIGIBLE',
      qualificationDetails: 'Kỹ thuật viên an toàn UAV EVN, chuyên trách hệ thống phanh dù khẩn cấp & cảm biến tránh va',
      conflict: null,
      reason: 'Đạt đầy đủ 5 tiêu chuẩn sẵn sàng kỹ thuật thiết bị (Đang rảnh)',
    },
    {
      id: 'usr-15',
      name: 'Phan Hải Long',
      role: 'TECHNICIAN',
      region: reg,
      availability: 'BUSY',
      eligibility: 'ELIGIBLE',
      isActive: true,
      isEligible: true,
      isWithinScope: true,
      isAvailable: false,
      overallEligibility: 'BUSY',
      qualificationDetails: 'Kỹ sư trưởng bảo dưỡng đội bay UAV',
      conflict: 'Đang bảo dưỡng định kỳ trạm sạc nhanh tại Tổ truyền tải điện Hà Đông',
      reason: 'Trùng lịch bảo dưỡng thiết bị cấp xưởng',
    },
  ];
}

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
  const reqInspectors = Number(x['requiredInspectors'] ?? scopeGeometry['requiredInspectors'] ?? 1);
  const reqAnalysts = Number(x['requiredAnalysts'] ?? scopeGeometry['requiredAnalysts'] ?? 1);
  const reqTechnicians = Number(x['requiredTechnicians'] ?? scopeGeometry['requiredTechnicians'] ?? 1);

  const siteChecks = rawSiteChecks.length
    ? (rawSiteChecks.map(objectOf) as unknown as readonly SiteCheckItem[])
    : defaultSiteChecks(isFeasible, bufferMeters, maxAltitude);

  const rawInspection = x['droneInspection'] ? normalizeInspectionResult(x['droneInspection'], 'UAV-DEFAULT') : null;

  const rawPersonnelCandidates = arrayOf(x['personnelCandidates']).map((c) => normalizeCandidate(objectOf(c)));
  const personnelCheck = x['personnel']
    ? checkOf(x['personnel'])
    : derivedPersonnelCheck(rawPersonnelCandidates, reqInspectors, reqAnalysts, reqTechnicians);

  const siteCheck = x['site'] ? checkOf(x['site']) : derivedCheck(status !== 'UNKNOWN');
  const uavCheck = x['uav'] ? checkOf(x['uav']) : derivedCheck(arrayOf(x['uavCandidates']).length > 0);
  const technicalCheck = x['technical'] ? checkOf(x['technical']) : derivedCheck(status === 'READY');

  const computedStatus = (personnelCheck.status === 'FAIL' || siteCheck.status === 'FAIL' || uavCheck.status === 'FAIL')
    ? (status === 'READY' ? 'NOT_READY' : status)
    : status;

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
    requiredInspectors: reqInspectors,
    requiredAnalysts: reqAnalysts,
    requiredTechnicians: reqTechnicians,
    site: siteCheck,
    personnel: personnelCheck,
    uav: uavCheck,
    technical: technicalCheck,
    status: computedStatus,
    validUntil: x['validUntil'] == null ? null : stringOf(x['validUntil']),
    createdBy: x['createdBy'] == null ? null : stringOf(x['createdBy']),
    updatedAt: x['updatedAt'] == null ? null : stringOf(x['updatedAt']),
    consumedMissionId: x['consumedMissionId'] == null ? null : stringOf(x['consumedMissionId']),
    personnelCandidates: rawPersonnelCandidates as never,
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

function normalizeCandidate(c: Record<string, unknown>): Record<string, unknown> {
  const roleRaw = stringOf(c['role'] || 'INSPECTOR').toUpperCase();
  const role = roleRaw.includes('PILOT') || roleRaw.includes('INSPECT')
    ? 'INSPECTOR'
    : roleRaw.includes('ANALYST')
    ? 'ANALYST'
    : roleRaw.includes('TECH')
    ? 'TECHNICIAN'
    : roleRaw;

  return {
    ...c,
    id: stringOf(c['id']),
    name: stringOf(c['name'] || c['fullName']),
    role,
    region: stringOf(c['region'] || c['regionName']),
    availability: stringOf(c['availability'] || 'AVAILABLE'),
    eligibility: stringOf(c['eligibility'] || c['overallEligibility'] || 'ELIGIBLE'),
    isActive: c['isActive'] !== undefined ? Boolean(c['isActive']) : true,
    isEligible: c['isEligible'] !== undefined ? Boolean(c['isEligible']) : true,
    isWithinScope: c['isWithinScope'] !== undefined ? Boolean(c['isWithinScope']) : true,
    isAvailable: c['isAvailable'] !== undefined ? Boolean(c['isAvailable']) : true,
    overallEligibility: stringOf(c['overallEligibility'] || c['eligibility'] || 'ELIGIBLE'),
    qualificationDetails: stringOf(c['qualificationDetails'] || c['reason'] || 'Đủ chứng chỉ chuyên môn EVN'),
    conflict: c['conflict'] == null ? null : stringOf(c['conflict']),
    reason: stringOf(c['reason'] || 'Đủ 5 tiêu chuẩn sẵn sàng vận hành'),
  };
}

export function derivedPersonnelCheck(
  candidates: readonly Record<string, unknown>[],
  reqInspectors = 1,
  reqAnalysts = 1,
  reqTechnicians = 1
): ReadinessCheck {
  if (!candidates || candidates.length === 0) {
    return { status: 'FAIL', reason: 'Chưa có ứng viên nhân sự nào trong hệ thống.', evaluatedAt: new Date().toISOString() };
  }

  // Filter ONLY available ("đang rảnh") candidates satisfying 5 AND criteria:
  // Active, Scope, Eligible, and Available (no conflict & availability === 'AVAILABLE')
  const availableCandidates = candidates.filter((c) => {
    const activeOk = c['isActive'] !== false;
    const scopeOk = c['isWithinScope'] !== false;
    const eligOk = c['isEligible'] !== false && stringOf(c['eligibility'] || c['overallEligibility']).toUpperCase() === 'ELIGIBLE';
    const availOk = c['isAvailable'] !== false && stringOf(c['availability']).toUpperCase() === 'AVAILABLE' && !c['conflict'];
    return activeOk && scopeOk && eligOk && availOk;
  });

  const availableInspectors = availableCandidates.filter((c) => {
    const r = stringOf(c['role']).toUpperCase();
    return r.includes('INSPECT') || r.includes('PILOT');
  });

  const availableAnalysts = availableCandidates.filter((c) => {
    const r = stringOf(c['role']).toUpperCase();
    return r.includes('ANALYST');
  });

  const availableTechnicians = availableCandidates.filter((c) => {
    const r = stringOf(c['role']).toUpperCase();
    return r.includes('TECH') || r.includes('MAINTENANCE');
  });

  const missingList: string[] = [];
  if (availableInspectors.length < reqInspectors) {
    missingList.push(
      `Thiếu ${reqInspectors - availableInspectors.length} Inspector (khả dụng ${availableInspectors.length}/${reqInspectors})`
    );
  }
  if (availableAnalysts.length < reqAnalysts) {
    missingList.push(
      `Thiếu ${reqAnalysts - availableAnalysts.length} Analyst (khả dụng ${availableAnalysts.length}/${reqAnalysts})`
    );
  }
  if (availableTechnicians.length < reqTechnicians) {
    missingList.push(
      `Thiếu ${reqTechnicians - availableTechnicians.length} Technician (khả dụng ${availableTechnicians.length}/${reqTechnicians})`
    );
  }

  if (missingList.length === 0) {
    return {
      status: 'PASS',
      reason: `Đạt đủ định mức nhân sự đang rảnh (${availableInspectors.length} Inspector, ${availableAnalysts.length} Analyst, ${availableTechnicians.length} Technician).`,
      evaluatedAt: new Date().toISOString(),
    };
  }

  return {
    status: 'FAIL',
    reason: `Không đạt định mức nhân sự: ${missingList.join('; ')}. Hệ thống chỉ tính nhân sự đang rảnh trong CSDL.`,
    evaluatedAt: new Date().toISOString(),
  };
}

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

function createSimulatedAssessment(
  request: AssessmentCreateRequest,
  realCandidates?: readonly PersonnelCandidate[]
): PreMissionAssessment {
  const id = `asm-${Date.now().toString(36)}`;
  const codeNum = Math.floor(1000 + Math.random() * 9000);
  const plannedStart = formatIsoDate(request.plannedStart) || new Date(Date.now() + 3600000).toISOString();
  const plannedEnd = formatIsoDate(request.plannedEnd) || new Date(Date.now() + 14400000).toISOString();

  const candidates = (realCandidates && realCandidates.length > 0)
    ? realCandidates
    : getDefaultFallbackPersonnel(request.regionId);

  const reqInsp = request.requiredInspectors ?? 1;
  const reqAna = request.requiredAnalysts ?? 1;
  const reqTech = request.requiredTechnicians ?? 1;

  const personnelCheck = derivedPersonnelCheck(candidates as any, reqInsp, reqAna, reqTech);
  const status: AssessmentStatus = personnelCheck.status === 'FAIL' ? 'NOT_READY' : 'READY';

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
    requiredInspectors: reqInsp,
    requiredAnalysts: reqAna,
    requiredTechnicians: reqTech,
    site: { status: 'PASS', reason: null, evaluatedAt: new Date().toISOString() },
    personnel: personnelCheck,
    uav: { status: 'PASS', reason: null, evaluatedAt: new Date().toISOString() },
    technical: { status: 'PASS', reason: null, evaluatedAt: new Date().toISOString() },
    status,
    validUntil: new Date(Date.now() + 86400000 * 2).toISOString(),
    createdBy: 'Kỹ sư quản lý bay',
    updatedAt: new Date().toISOString(),
    consumedMissionId: null,
    personnelCandidates: candidates,
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

function createSimulatedAssessmentById(
  id: string,
  targetStatus?: string,
  realCandidates?: readonly PersonnelCandidate[],
  reqInsp = 1,
  reqAna = 1,
  reqTech = 1
): PreMissionAssessment {
  const candidates = (realCandidates && realCandidates.length > 0)
    ? realCandidates
    : getDefaultFallbackPersonnel();

  const personnelCheck = derivedPersonnelCheck(candidates as any, reqInsp, reqAna, reqTech);
  const status: AssessmentStatus = targetStatus
    ? (targetStatus === 'READY' && personnelCheck.status === 'FAIL' ? 'NOT_READY' : targetStatus)
    : (personnelCheck.status === 'FAIL' ? 'NOT_READY' : 'READY');

  return {
    id,
    assessmentCode: `PMA-${id.slice(0, 8).toUpperCase()}`,
    regionName: 'Khu vực quản lý',
    lineName: 'Đường dây 220kV Cát Lái - Thủ Đức',
    assetCount: 3,
    plannedStart: new Date(Date.now() + 3600000).toISOString(),
    plannedEnd: new Date(Date.now() + 14400000).toISOString(),
    requiredInspectors: reqInsp,
    requiredAnalysts: reqAna,
    requiredTechnicians: reqTech,
    site: { status: 'PASS', reason: null, evaluatedAt: new Date().toISOString() },
    personnel: personnelCheck,
    uav: { status: 'PASS', reason: null, evaluatedAt: new Date().toISOString() },
    technical: { status: 'PASS', reason: null, evaluatedAt: new Date().toISOString() },
    status,
    validUntil: new Date(Date.now() + 86400000 * 2).toISOString(),
    createdBy: 'Kỹ sư quản lý bay',
    updatedAt: new Date().toISOString(),
    consumedMissionId: null,
    personnelCandidates: candidates,
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

