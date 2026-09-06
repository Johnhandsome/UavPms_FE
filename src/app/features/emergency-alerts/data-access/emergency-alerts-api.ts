import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject, signal, computed } from '@angular/core';
import { Observable, of, throwError } from 'rxjs';
import { catchError, map, tap } from 'rxjs/operators';
import { environment } from '../../../../environments/environment';
import { Auth } from '../../../core/auth/auth';
import {
  EmergencyAlertItem,
  ReviewAlertPayload,
  EscalateAlertPayload,
  EscalationManagerOption,
} from '../models/emergency-alert.models';

const SEED_ACTIVE_ALERTS: EmergencyAlertItem[] = [
  {
    id: 'ea-001',
    title: 'Phát hi?n dám cháy r?ng sát hành lang an toàn c?t 042',
    alertType: 'Cháy r?ng / Nhi?t d? cao de d?a du?ng dây',
    categoryCode: 'EMERGENCY-FIRE-CORRIDOR',
    severity: 'Critical',
    status: 'Active',
    detectedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    assetCode: 'TOW-220KV-042',
    assetName: 'C?t néo hãm d? s? 42 - 220kV',
    towerCode: 'C?t 042 (TOW-220KV-042)',
    lineName: 'Ðu?ng dây 220kV Hòa Bình - Hà Ðông',
    substationName: 'TBA 500kV Tây Hà N?i',
    latitude: 20.8924,
    longitude: 105.4182,
    imageUrl: '/images/defect-preview-frame.png',
    boundingBox: { x: 38, y: 32, width: 34, height: 38, isNormalized: true },
    confidenceScore: 96,
    aiModelName: 'EdgeYOLOv8-Thermal-UAV-v3.1',
    droneId: 'UAV-MATRICE-300-RTK-01',
    missionCode: 'MIS-20260904-EMG',
    description: 'C?m bi?n h?ng ngo?i nhi?t d? phát hi?n vùng nhi?t > 350°C cách dây d?n pha C du?i 12 mét. Khói d?m d?c de d?a s? c? phóng di?n ion hóa.',
  },
  {
    id: 'ea-002',
    title: 'Xo tua, d?t nhi?u tao dây d?n pha B s?p d?t gãy',
    alertType: 'T?n thuong co h?c dây d?n c?p bách',
    categoryCode: 'EMERGENCY-COND-BREAK',
    severity: 'Critical',
    status: 'Active',
    detectedAt: new Date(Date.now() - 42 * 60 * 1000).toISOString(),
    assetCode: 'COND-220KV-HB-043',
    assetName: 'Dây d?n nhôm lõi thép ACSR 400mm2',
    towerCode: 'Kho?ng c?t 042 - 043',
    lineName: 'Ðu?ng dây 220kV Hòa Bình - Hà Ðông',
    substationName: 'TBA 220kV Xuân Mai',
    latitude: 20.8988,
    longitude: 105.4295,
    imageUrl: '/images/defect-conductor-damage.png',
    boundingBox: { x: 45, y: 48, width: 32, height: 26, isNormalized: true },
    confidenceScore: 92,
    aiModelName: 'EdgeYOLOv8-GridStructural-v2.8',
    droneId: 'UAV-MATRICE-350-RTK-02',
    missionCode: 'MIS-20260904-INSP',
    description: 'Phát hi?n 6 tao nhôm ngoài b? xé to?c, v?n xo?n nghiêm tr?ng do sét dánh ho?c rung l?c gió l?n. Nguy co d?t r?i dây d?n khi t?i cao.',
  },
  {
    id: 'ea-003',
    title: 'Phóng di?n b? m?t chu?i cách di?n composite (Flashover)',
    alertType: 'Hu h?ng v?t li?u cách di?n cao áp',
    categoryCode: 'EMERGENCY-INS-FLASHOVER',
    severity: 'High',
    status: 'Active',
    detectedAt: new Date(Date.now() - 85 * 60 * 1000).toISOString(),
    assetCode: 'INS-COMP-TOW043-P1',
    assetName: 'Chu?i cách di?n néo polymer 220kV',
    towerCode: 'C?t 043 (TOW-220KV-043)',
    lineName: 'Ðu?ng dây 220kV Hòa Bình - Hà Ðông',
    substationName: 'TBA 500kV Tây Hà N?i',
    latitude: 20.9015,
    longitude: 105.4358,
    imageUrl: '/images/defect-insulator-flashover.png',
    boundingBox: { x: 42, y: 35, width: 28, height: 32, isNormalized: true },
    confidenceScore: 89,
    aiModelName: 'EdgeYOLOv8-GridStructural-v2.8',
    droneId: 'UAV-MATRICE-300-RTK-01',
    missionCode: 'MIS-20260904-EMG',
    description: 'V?t cháy den rãnh sâu do phóng di?n v?ng quang kéo dài. Bát cách di?n b? n?t n?, có nguy co dánh th?ng cách di?n gây s? c? rã lu?i.',
  },
];

const SEED_HISTORY_ALERTS: EmergencyAlertItem[] = [
  {
    id: 'ea-hist-001',
    title: 'Cây ngã d? dè dây cáp quang ch?ng sét OPGW',
    alertType: 'Vi ph?m kho?ng cách an toàn hành lang',
    categoryCode: 'EMERGENCY-TREE-FALL',
    severity: 'Critical',
    status: 'Escalated',
    detectedAt: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
    assetCode: 'OPGW-220KV-TOW039',
    assetName: 'Cáp quang k?t h?p ch?ng sét OPGW 70',
    towerCode: 'Kho?ng c?t 038 - 039',
    lineName: 'Ðu?ng dây 220kV Hòa Bình - Hà Ðông',
    latitude: 20.8841,
    longitude: 105.4052,
    imageUrl: '/images/defect-preview-frame.png',
    boundingBox: { x: 50, y: 40, width: 35, height: 35, isNormalized: true },
    confidenceScore: 94,
    aiModelName: 'EdgeYOLOv8-Thermal-UAV-v3.1',
    droneId: 'UAV-MATRICE-300-RTK-01',
    missionCode: 'MIS-20260903-STORM',
    description: 'Cây keo lai cao 18m b? b?t g?c sau bão, ng?n cây v?t ngang cáp OPGW t?o l?c cang nguy hi?m.',
    reviewInfo: {
      reviewedBy: 'Nguy?n Van Minh (Analyst)',
      reviewerRole: 'Analyst',
      reviewedAt: new Date(Date.now() - 23 * 3600 * 1000).toISOString(),
      decision: 'Escalated',
      escalatedToUserId: 'mgr-001',
      escalatedToUserName: 'Tr?n H?u Nam (Tru?ng Trung tâm Ði?u d?)',
      escalationReason: 'Tình tr?ng kh?n c?p c?p d? 1: C?n di?u d?ng ngay Ð?i Truy?n t?i di?n khu v?c ch?t t?a kh?n c?p và ng?t di?n t?m th?i do?n tuy?n.',
    },
  },
  {
    id: 'ea-hist-002',
    title: 'Bung bu lông thanh gi?ng chân c?t néo góc 044',
    alertType: 'Hu h?ng k?t c?u co khí c?t',
    categoryCode: 'EMERGENCY-BOLT-MISSING',
    severity: 'High',
    status: 'Confirmed',
    detectedAt: new Date(Date.now() - 48 * 3600 * 1000).toISOString(),
    assetCode: 'TWR-BOLT-TOW044',
    assetName: 'Khung gi?ng ch?u l?c góc du?i',
    towerCode: 'C?t néo 044 (TOW-220KV-044)',
    lineName: 'Ðu?ng dây 220kV Hòa Bình - Hà Ðông',
    latitude: 20.9122,
    longitude: 105.4491,
    imageUrl: '/images/defect-bolt-loose.png',
    boundingBox: { x: 55, y: 44, width: 22, height: 26, isNormalized: true },
    confidenceScore: 91,
    aiModelName: 'EdgeYOLOv8-GridStructural-v2.8',
    droneId: 'UAV-MATRICE-350-RTK-02',
    missionCode: 'MIS-20260902-REG',
    description: '2 bu lông M24 b? bung dai ?c hoàn toàn do rung d?ng co h?c.',
    reviewInfo: {
      reviewedBy: 'Lê Thu Trang (Analyst)',
      reviewerRole: 'Analyst',
      reviewedAt: new Date(Date.now() - 46 * 3600 * 1000).toISOString(),
      decision: 'Confirmed',
      notes: 'Ðã th?m d?nh chu?n xác. L?p phi?u công tác s?a ch?a b?o du?ng d?nh k? tu?n này.',
    },
  },
];

export const MOCK_MANAGERS: EscalationManagerOption[] = [
  {
    id: 'c8f49e0b-5421-4f1b-8a71-365287b40001',
    fullName: 'Tr?n H?u Nam',
    email: 'nam.tran@evn-uavpms.vn',
    role: 'Manager',
    department: 'Trung Tâm Ði?u Ð? H? Th?ng Ði?n (A0/A1)',
    phone: '0912 345 678',
  },
  {
    id: 'd9a51f1c-6532-4e2c-9b82-476398c50002',
    fullName: 'Ph?m Ð?c Dung',
    email: 'dung.pham@evn-uavpms.vn',
    role: 'Manager',
    department: 'Ban K? Thu?t & An Toàn Lu?i Ði?n Cao Th?',
    phone: '0983 222 333',
  },
  {
    id: 'e0b62a2d-7643-4f3d-ac93-587409d60003',
    fullName: 'Vu M?nh Cu?ng',
    email: 'cuong.vu@evn-uavpms.vn',
    role: 'Supervisor',
    department: 'Ð?i Truy?n T?i Ði?n Khu V?c Tây Hà N?i',
    phone: '0904 888 999',
  },
];

@Injectable({
  providedIn: 'root',
})
export class EmergencyAlertsApi {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(Auth);

  // Reactive state
  private readonly activeAlertsSignal = signal<EmergencyAlertItem[]>(SEED_ACTIVE_ALERTS);
  private readonly historyAlertsSignal = signal<EmergencyAlertItem[]>(SEED_HISTORY_ALERTS);
  private readonly managersSignal = signal<EscalationManagerOption[]>(MOCK_MANAGERS);

  readonly activeAlerts = computed(() => this.activeAlertsSignal());
  readonly historyAlerts = computed(() => this.historyAlertsSignal());
  readonly managers = computed(() => this.managersSignal());
  readonly activeCount = computed(() => this.activeAlertsSignal().length);

  /**
   * Fetch active alerts from backend or fallback to local signal
   */
  fetchActiveAlerts(): Observable<EmergencyAlertItem[]> {
    return this.http.get<EmergencyAlertItem[]>(`${environment.apiBaseUrl}/alerts/active`).pipe(
      map((res) => (Array.isArray(res) && res.length > 0 ? res : this.activeAlertsSignal())),
      tap((alerts) => this.activeAlertsSignal.set(alerts)),
      catchError((err: HttpErrorResponse) => {
        console.warn('[EmergencyAlertsApi] Backend /alerts/active not yet deployed or error, using local queue:', err.status);
        return of(this.activeAlertsSignal());
      }),
    );
  }

  /**
   * Fetch alert history
   */
  fetchAlertHistory(params?: { status?: string; page?: number; pageSize?: number }): Observable<EmergencyAlertItem[]> {
    const statusParam = params?.status ? `?status=${params.status}` : '';
    return this.http.get<EmergencyAlertItem[]>(`${environment.apiBaseUrl}/alerts${statusParam}`).pipe(
      map((res) => (Array.isArray(res) && res.length > 0 ? res : this.historyAlertsSignal())),
      tap((history) => this.historyAlertsSignal.set(history)),
      catchError((err: HttpErrorResponse) => {
        console.warn('[EmergencyAlertsApi] Backend /alerts history not yet deployed, using local queue:', err.status);
        return of(this.historyAlertsSignal());
      }),
    );
  }

  /**
   * Confirm or Dismiss (Reject) an alert: PUT /api/v1/alerts/{id}/review
   */
  reviewAlert(id: string, payload: ReviewAlertPayload): Observable<void> {
    const user = this.auth.user();
    const reviewerName = user?.fullName || user?.email || 'Chuyên viên Analyst';
    const reviewerRole = user?.role || 'Analyst';

    return this.http.put<void>(`${environment.apiBaseUrl}/alerts/${id}/review`, payload).pipe(
      catchError((err: HttpErrorResponse) => {
        console.warn('[EmergencyAlertsApi] Fallback local review for alert:', id, err.status);
        return of(undefined as void);
      }),
      tap(() => {
        // Move item from active to history
        const active = this.activeAlertsSignal();
        const target = active.find((a) => a.id === id);
        if (target) {
          const updated: EmergencyAlertItem = {
            ...target,
            status: payload.status,
            reviewInfo: {
              reviewedBy: reviewerName,
              reviewerRole: reviewerRole,
              reviewedAt: new Date().toISOString(),
              decision: payload.status,
              notes: payload.notes,
            },
          };
          this.activeAlertsSignal.set(active.filter((a) => a.id !== id));
          this.historyAlertsSignal.update((hist) => [updated, ...hist]);
        }
      }),
    );
  }

  /**
   * Escalate an alert: POST /api/v1/alerts/{id}/escalate
   */
  escalateAlert(id: string, payload: EscalateAlertPayload): Observable<void> {
    const user = this.auth.user();
    const reviewerName = user?.fullName || user?.email || 'Chuyên viên Analyst';
    const reviewerRole = user?.role || 'Analyst';
    const manager = this.managersSignal().find((m) => m.id === payload.escalatedToUserId);
    const targetManagerName = manager ? `${manager.fullName} (${manager.department})` : 'C?p Qu?n Lý H? Th?ng';

    return this.http.post<void>(`${environment.apiBaseUrl}/alerts/${id}/escalate`, payload).pipe(
      catchError((err: HttpErrorResponse) => {
        console.warn('[EmergencyAlertsApi] Fallback local escalate for alert:', id, err.status);
        return of(undefined as void);
      }),
      tap(() => {
        const active = this.activeAlertsSignal();
        const target = active.find((a) => a.id === id);
        if (target) {
          const updated: EmergencyAlertItem = {
            ...target,
            status: 'Escalated',
            reviewInfo: {
              reviewedBy: reviewerName,
              reviewerRole: reviewerRole,
              reviewedAt: new Date().toISOString(),
              decision: 'Escalated',
              escalatedToUserId: payload.escalatedToUserId,
              escalatedToUserName: targetManagerName,
              escalationReason: payload.reason,
            },
          };
          this.activeAlertsSignal.set(active.filter((a) => a.id !== id));
          this.historyAlertsSignal.update((hist) => [updated, ...hist]);
        }
      }),
    );
  }

  /**
   * Ingest real-time alert received from SignalR
   */
  ingestRealtimeAlert(alert: EmergencyAlertItem): void {
    const exists = this.activeAlertsSignal().some((a) => a.id === alert.id);
    if (!exists) {
      this.activeAlertsSignal.update((list) => [alert, ...list]);
    }
  }

  /**
   * Simulation helper for demo & manual testing of Edge AI incoming emergency detection
   */
  simulateRealtimeAlert(): EmergencyAlertItem {
    const randomId = 'ea-' + Math.random().toString(36).substring(2, 7);
    const mockTypes = [
      {
        title: 'Phát hi?n phóng di?n h? quang chu?i bát cách di?n pha A',
        type: 'H? quang di?n nguy hi?m',
        code: 'EMG-ARC-FLASHOVER',
        image: '/images/defect-insulator-crack.png',
        desc: 'Tia l?a h? quang sáng chói kèm nhi?t d? > 400°C phát hi?n qua c?m bi?n quang ph? UV.',
      },
      {
        title: 'V?t th? l? (B?t rom / Di?u kh?ng l?) vu?ng vào du?ng dây',
        type: 'D? v?t vi ph?m kho?ng cách phóng di?n',
        code: 'EMG-FOREIGN-OBJECT',
        image: '/images/defect-conductor-damage.png',
        desc: 'Màng b?t nông nghi?p dài 4 mét m?c trên dây d?n dang cháy xém do phóng di?n v?ng quang.',
      },
      {
        title: 'S?t l? d?t de d?a s?p móng tr? néo s? 045',
        type: 'S?t l? d?a ch?t nguy co d? c?t',
        code: 'EMG-GEO-LANDSLIDE',
        image: '/images/defect-preview-frame.png',
        desc: 'Mua l?n gây s?t l? taluy âm cách móng tr? néo 1.8 mét. Ð?t dá dang s?t lún nhanh.',
      },
    ];

    const pick = mockTypes[Math.floor(Math.random() * mockTypes.length)];
    const newAlert: EmergencyAlertItem = {
      id: randomId,
      title: pick.title,
      alertType: pick.type,
      categoryCode: pick.code,
      severity: 'Critical',
      status: 'Active',
      detectedAt: new Date().toISOString(),
      assetCode: `TOW-220KV-0${Math.floor(Math.random() * 20 + 35)}`,
      assetName: 'C?t d? néo du?ng dây 220kV',
      towerCode: `C?t 0${Math.floor(Math.random() * 20 + 35)}`,
      lineName: 'Ðu?ng dây 220kV Hòa Bình - Hà Ðông',
      substationName: 'TBA 500kV Tây Hà N?i',
      latitude: 20.89 + Math.random() * 0.05,
      longitude: 105.41 + Math.random() * 0.05,
      imageUrl: pick.image,
      boundingBox: { x: 35 + Math.random() * 15, y: 30 + Math.random() * 15, width: 30, height: 30, isNormalized: true },
      confidenceScore: Math.floor(Math.random() * 10 + 90),
      aiModelName: 'EdgeYOLOv8-Emergency-Drone-v3.2',
      droneId: 'UAV-MATRICE-300-RTK-01',
      missionCode: 'MIS-20260904-REALTIME',
      description: pick.desc,
    };

    this.ingestRealtimeAlert(newAlert);
    return newAlert;
  }
}
