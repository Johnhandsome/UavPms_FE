import { DatePipe, Location } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  effect,
  ElementRef,
  inject,
  OnDestroy,
  OnInit,
  signal,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormBuilder, FormsModule, ReactiveFormsModule, Validators } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import * as L from 'leaflet';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { Auth } from '../../../../core/auth/auth';
import { DroneDto } from '../../../../models/drones.models';
import { MissionCreateRequest } from '../../../../models/missions.models';
import { PersonnelCandidate, PreMissionAssessment, UavCandidate } from '../../../../models/pre-mission.models';
import { UserRecord } from '../../../../models/users.models';
import { NotificationsRealtime } from '../../../notifications/data-access/notifications-realtime';
import { NotificationsStore } from '../../../notifications/data-access/notifications-store';
import { PreMissionApi } from '../../../pre-mission/data-access/pre-mission-api';
import { UsersApi } from '../../../users/data-access/users-api';
import { DronesApi } from '../../data-access/drones-api';
import { MissionsApi } from '../../data-access/missions-api';

export type DeadlinePreset = '2h' | '6h' | '12h' | '24h' | 'custom';

@Component({
  selector: 'app-mission-create',
  imports: [ReactiveFormsModule, FormsModule, RouterLink, NzIconModule, DatePipe],
  templateUrl: './mission-create.html',
  styleUrl: './mission-create.scss',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MissionCreate implements OnInit, AfterViewInit, OnDestroy {
  private readonly api = inject(MissionsApi);
  private readonly realtime = inject(NotificationsRealtime);
  private readonly preMissionApi = inject(PreMissionApi);
  private readonly dronesApi = inject(DronesApi);
  private readonly usersApi = inject(UsersApi);
  private readonly notificationsStore = inject(NotificationsStore);
  private readonly auth = inject(Auth);
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly location = inject(Location);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly sourceAssessmentId = signal<string>('');
  protected readonly assessmentData = signal<PreMissionAssessment | null>(null);
  protected readonly loadingAssessment = signal<boolean>(false);
  protected readonly busy = signal<boolean>(false);
  protected readonly error = signal<string>('');
  protected readonly successMessage = signal<string>('');

  protected readonly users = signal<readonly UserRecord[]>([]);
  protected readonly drones = signal<readonly DroneDto[]>([]);
  protected readonly currentUser = this.auth.user;

  // Deadline Preset & State
  protected readonly selectedPreset = signal<DeadlinePreset>('6h');
  protected readonly showMapPreview = signal<boolean>(true);
  protected readonly currentMapType = signal<'google-streets' | 'google-hybrid' | 'carto'>('google-streets');

  private readonly mapContainer = viewChild<ElementRef<HTMLDivElement>>('mapPreviewContainer');
  private map: L.Map | null = null;
  private currentTileLayer: L.TileLayer | null = null;
  private markersLayer = L.layerGroup();
  private polylineLayer = L.layerGroup();
  private bufferLayer = L.layerGroup();
  private resizeObserver: ResizeObserver | null = null;

  constructor() {
    effect(() => {
      const ass = this.assessmentData();
      const show = this.showMapPreview();
      const el = this.mapContainer();
      if (ass && show && el) {
        setTimeout(() => this.initMapPreview(), 60);
      }
    });
  }

  // Reactive Form
  protected readonly form = this.fb.nonNullable.group({
    name: ['', [Validators.required, Validators.minLength(5)]],
    scheduledAt: ['', Validators.required],
    plannedEnd: ['', Validators.required],
    inspectorId: ['', Validators.required],
    droneId: ['', Validators.required],
    confirmationDeadline: ['', Validators.required],
    managerInstructions: [''],
    notifyInApp: [true],
    notifySms: [true],
    notifyEmail: [true],
    description: [''],
  });

  // Derived candidate lists
  protected readonly eligiblePersonnel = computed<readonly PersonnelCandidate[]>(() => {
    const ass = this.assessmentData();
    if (ass && ass.personnelCandidates && ass.personnelCandidates.length > 0) {
      return ass.personnelCandidates.filter((p) => p.eligibility === 'ELIGIBLE');
    }
    // Fallback to active users
    return this.users().map((u) => ({
      id: u.id,
      name: u.fullName || u.email,
      role: (u.role as any) || 'Pilot / Inspector',
      region: 'Khu vực quản lý',
      availability: 'AVAILABLE' as const,
      eligibility: 'ELIGIBLE' as const,
      reason: 'Đủ chứng chỉ chuyên môn vận hành bay UAV',
    }));
  });

  protected readonly eligibleDrones = computed<readonly UavCandidate[]>(() => {
    const ass = this.assessmentData();
    if (ass && ass.uavCandidates && ass.uavCandidates.length > 0) {
      return ass.uavCandidates.filter((d) => d.eligibility === 'ELIGIBLE' || d.technicalHealth !== 'CRITICAL');
    }
    // Fallback to active drones
    return this.drones().map((d) => ({
      id: d.id,
      code: d.droneCode,
      name: d.name,
      operationalStatus: 'AVAILABLE' as const,
      technicalHealth: 'HEALTHY' as const,
      eligibility: 'ELIGIBLE' as const,
      battery: d.battery,
    }));
  });

  protected readonly selectedInspector = computed(() => {
    const id = this.form.controls.inspectorId.value;
    return this.eligiblePersonnel().find((p) => p.id === id);
  });

  protected readonly selectedDrone = computed(() => {
    const id = this.form.controls.droneId.value;
    return this.eligibleDrones().find((d) => d.id === id || d.code === id);
  });

  protected readonly corridorBufferMeters = computed<number>(() => {
    const ass = this.assessmentData();
    if (!ass || !ass.scopeGeometry || typeof ass.scopeGeometry !== 'object') return 50;
    const geom = ass.scopeGeometry as Record<string, unknown>;
    return Number(geom['corridorBufferMeters'] ?? 50);
  });

  ngOnInit(): void {
    this.loadUsersAndDrones();

    const assessmentId = this.route.snapshot.queryParamMap.get('assessmentId') || 'asm-mu9bfu1a';
    this.sourceAssessmentId.set(assessmentId);
    this.loadAssessment(assessmentId);

    // Synchronize deadline automatically if flight start time changes
    this.form.controls.scheduledAt.valueChanges
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((startVal) => {
        if (startVal && this.selectedPreset() !== 'custom') {
          const dl = this.computeDeadlineString(startVal, this.selectedPreset());
          this.form.controls.confirmationDeadline.setValue(dl, { emitEvent: false });
        }
      });
  }

  ngAfterViewInit(): void {
    setTimeout(() => this.initMapPreview(), 250);
  }

  ngOnDestroy(): void {
    this.cleanupMap();
  }

  private loadUsersAndDrones(): void {
    this.usersApi
      .getAll()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (users) => {
          this.users.set(users);
          if (!this.form.controls.inspectorId.value && users.length > 0) {
            const best = this.eligiblePersonnel()[0]?.id || users[0].id;
            this.form.controls.inspectorId.setValue(best);
          }
        },
        error: () => {},
      });

    this.dronesApi
      .getAll()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (drones) => {
          this.drones.set(drones);
          if (!this.form.controls.droneId.value && drones.length > 0) {
            const best = this.eligibleDrones()[0]?.id || drones[0].id;
            this.form.controls.droneId.setValue(best);
          }
        },
        error: () => {},
      });
  }

  private loadAssessment(id: string): void {
    this.loadingAssessment.set(true);
    this.preMissionApi
      .get(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (ass) => {
          this.assessmentData.set(ass);
          this.loadingAssessment.set(false);

          // Calculate forward-safe execution window
          let startTimeMs = ass.plannedStart ? new Date(ass.plannedStart).getTime() : Date.now() + 2 * 3600000;
          if (isNaN(startTimeMs) || startTimeMs <= Date.now() + 30 * 60 * 1000) {
            startTimeMs = Date.now() + 2 * 3600000; // default 2 hours from now
          }
          let endTimeMs = ass.plannedEnd ? new Date(ass.plannedEnd).getTime() : startTimeMs + 4 * 3600000;
          if (isNaN(endTimeMs) || endTimeMs <= startTimeMs) {
            endTimeMs = startTimeMs + 4 * 3600000;
          }

          const startStr = this.formatDateTimeInput(new Date(startTimeMs));
          const endStr = this.formatDateTimeInput(new Date(endTimeMs));

          // Calculate default deadline (6 hours before start, or safely placed before start)
          const deadlineStr = this.computeDeadlineString(startStr, '6h');

          // Pick best inspector & drone candidates with fallbacks
          const bestInspector =
            ass.personnelCandidates?.find((p) => p.eligibility === 'ELIGIBLE')?.id ||
            ass.personnelCandidates?.[0]?.id ||
            this.eligiblePersonnel()[0]?.id ||
            this.users()[0]?.id ||
            '';

          const bestDrone =
            ass.uavCandidates?.find((d) => d.eligibility === 'ELIGIBLE')?.id ||
            ass.uavCandidates?.[0]?.id ||
            this.eligibleDrones()[0]?.id ||
            this.drones()[0]?.id ||
            '';

          this.form.patchValue({
            name: `Khảo sát ${ass.regionName || 'EVN'}${ass.lineName ? ' - ' + ass.lineName : ''} [${ass.assessmentCode}]`,
            scheduledAt: startStr,
            plannedEnd: endStr,
            confirmationDeadline: deadlineStr,
            inspectorId: bestInspector,
            droneId: bestDrone,
            managerInstructions: `Yêu cầu đội bay kiểm tra kỹ khoảng cách an toàn hành lang lưới điện (${this.corridorBufferMeters()}m), lưu ý tốc độ gió giật bề mặt và hoàn thành xác nhận trước hạn chót.`,
            description: `Nhiệm vụ bay kiểm tra được kế thừa từ Đánh giá tiền nhiệm vụ ${ass.assessmentCode}. Phạm vi: ${ass.assetCount} vị trí cột điện.`,
          });

          setTimeout(() => {
            this.initMapPreview();
            this.renderMapTowers();
          }, 80);
        },
        error: () => {
          this.loadingAssessment.set(false);
          this.error.set('Không thể tải thông tin Đánh giá tiền nhiệm vụ. Vui lòng thử lại.');
        },
      });
  }

  protected setDeadlinePreset(preset: DeadlinePreset): void {
    this.selectedPreset.set(preset);
    if (preset === 'custom') return;

    const startVal = this.form.controls.scheduledAt.value;
    const deadlineVal = this.computeDeadlineString(startVal, preset);
    this.form.controls.confirmationDeadline.setValue(deadlineVal);
  }

  private computeDeadlineString(startIsoOrInput: string, preset: DeadlinePreset): string {
    const startTime = startIsoOrInput ? new Date(startIsoOrInput).getTime() : Date.now() + 2 * 3600000;
    let offsetHours = 6;
    if (preset === '2h') offsetHours = 2;
    else if (preset === '6h') offsetHours = 6;
    else if (preset === '12h') offsetHours = 12;
    else if (preset === '24h') offsetHours = 24;

    let deadlineMs = startTime - offsetHours * 3600000;
    // CRITICAL: The confirmation deadline MUST ALWAYS be before the flight start time
    if (deadlineMs >= startTime || deadlineMs <= Date.now()) {
      const leadTime = startTime - Date.now();
      if (leadTime > 3600000) {
        deadlineMs = startTime - 30 * 60 * 1000; // 30 mins before flight
      } else {
        deadlineMs = Math.max(Date.now() + 5 * 60 * 1000, startTime - 10 * 60 * 1000);
      }
    }
    return this.formatDateTimeInput(new Date(deadlineMs));
  }

  private formatDateTimeInput(d: Date): string {
    const pad = (n: number) => (n < 10 ? '0' + n : String(n));
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  protected toggleMapPreview(): void {
    this.showMapPreview.update((v) => !v);
    if (this.showMapPreview()) {
      setTimeout(() => {
        this.initMapPreview();
      }, 60);
    } else {
      this.cleanupMap();
    }
  }

  protected goBack(): void {
    const ass = this.assessmentData();
    if (ass) {
      this.router.navigate(['/pre-mission', ass.id]);
    } else {
      this.location.back();
    }
  }

  // --- Map Preview Methods ---
  protected setMapType(type: 'google-streets' | 'google-hybrid' | 'carto'): void {
    this.currentMapType.set(type);
    if (!this.map) return;

    if (this.currentTileLayer) {
      this.map.removeLayer(this.currentTileLayer);
      this.currentTileLayer = null;
    }

    let tileUrl: string;
    let maxZoom = 20;
    let subdomains = ['mt0', 'mt1', 'mt2', 'mt3'];
    let attribution = '© Google Maps | UAV-PMS MF02';

    switch (type) {
      case 'google-hybrid':
        tileUrl = 'https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}';
        attribution = '© Google Maps Vệ Tinh | UAV-PMS MF02';
        break;
      case 'carto':
        tileUrl = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
        subdomains = ['a', 'b', 'c', 'd'];
        maxZoom = 19;
        attribution = '© CARTO · OpenStreetMap | EVN UAV-PMS';
        break;
      case 'google-streets':
      default:
        tileUrl = 'https://{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}';
        attribution = '© Google Maps | UAV-PMS MF02';
        break;
    }

    const tileLayer = L.tileLayer(tileUrl, {
      maxZoom,
      subdomains,
      attribution,
      updateWhenIdle: false,
      updateWhenZooming: false,
      keepBuffer: 6,
    });

    let hasFallenBack = false;
    tileLayer.on('tileerror', () => {
      if (!hasFallenBack) {
        hasFallenBack = true;
        tileLayer.setUrl('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png');
      }
    });

    this.currentTileLayer = tileLayer;
    this.currentTileLayer.addTo(this.map);
  }

  private initMapPreview(): void {
    const container = this.mapContainer()?.nativeElement ?? (document.getElementById('missionCreateMapContainer') as HTMLDivElement | null);
    if (!container) return;

    if (this.map) {
      if (this.map.getContainer() !== container) {
        this.cleanupMap();
      } else {
        this.map.invalidateSize();
        this.renderMapTowers();
        return;
      }
    }

    if ((container as any)._leaflet_id) {
      (container as any)._leaflet_id = null;
    }

    this.map = L.map(container, {
      center: [16.0544, 108.2022],
      zoom: 13,
      zoomControl: true,
      scrollWheelZoom: false,
    });

    this.bufferLayer = L.layerGroup().addTo(this.map);
    this.polylineLayer = L.layerGroup().addTo(this.map);
    this.markersLayer = L.layerGroup().addTo(this.map);

    this.setMapType(this.currentMapType());

    if (typeof ResizeObserver !== 'undefined') {
      if (this.resizeObserver) {
        this.resizeObserver.disconnect();
      }
      this.resizeObserver = new ResizeObserver(() => {
        this.map?.invalidateSize();
      });
      this.resizeObserver.observe(container);
    }

    this.map.whenReady(() => {
      this.map?.invalidateSize();
      this.renderMapTowers();
    });

    setTimeout(() => {
      this.map?.invalidateSize();
      this.renderMapTowers();
    }, 80);

    setTimeout(() => {
      this.map?.invalidateSize();
    }, 280);
  }

  private renderMapTowers(): void {
    if (!this.map) {
      this.initMapPreview();
      return;
    }
    this.markersLayer.clearLayers();
    this.polylineLayer.clearLayers();
    this.bufferLayer.clearLayers();

    const ass = this.assessmentData();
    if (!ass || !ass.scopeAssetIds || ass.scopeAssetIds.length === 0) return;

    const bufferMeters = this.corridorBufferMeters();
    let baseLat = 16.0544;
    let baseLng = 108.2022;
    const reg = (ass.regionName || ass.regionId || '').toLowerCase();
    if (reg.includes('bắc') || reg.includes('north') || reg.includes('hn')) {
      baseLat = 21.0285;
      baseLng = 105.8542;
    } else if (reg.includes('nam') || reg.includes('south') || reg.includes('hcm')) {
      baseLat = 10.8231;
      baseLng = 106.6297;
    }

    const latLngs: [number, number][] = [];

    ass.scopeAssetIds.forEach((code, idx) => {
      const lat = baseLat + idx * 0.0045;
      const lng = baseLng + idx * 0.0065;
      latLngs.push([lat, lng]);

      // Safety buffer
      const circle = L.circle([lat, lng], {
        radius: bufferMeters,
        color: '#0284c7',
        fillColor: '#38bdf8',
        fillOpacity: 0.18,
        weight: 1.5,
        dashArray: '4, 4',
      });
      this.bufferLayer.addLayer(circle);

      // Tower marker
      const marker = L.circleMarker([lat, lng], {
        radius: 7,
        fillColor: '#0052cc',
        color: '#ffffff',
        weight: 2,
        fillOpacity: 1,
      });
      marker.bindTooltip(`Cột ${idx + 1}: ${code}`, {
        permanent: false,
        direction: 'top',
        className: 'evn-map-tooltip',
        offset: [0, -6],
      });
      marker.bindPopup(`
        <div style="font-family: inherit; font-size: 12px; line-height: 1.4; padding: 2px;">
          <strong style="color: #0369a1;">Vị trí cột ${idx + 1}</strong>
          <div style="font-family: monospace; font-weight: 600; margin: 2px 0;">${code}</div>
          <div style="color: #64748b; font-size: 11px;">Hành lang an toàn: <strong>${bufferMeters}m</strong></div>
        </div>
      `);
      this.markersLayer.addLayer(marker);
    });

    if (latLngs.length > 1) {
      const poly = L.polyline(latLngs, {
        color: '#0052cc',
        weight: 3.5,
        dashArray: '6, 6',
      });
      this.polylineLayer.addLayer(poly);
    }

    if (latLngs.length > 0) {
      const bounds = L.latLngBounds(latLngs);
      this.map.fitBounds(bounds, { padding: [25, 25], maxZoom: 16 });
    }
  }

  protected refreshMap(): void {
    if (this.map) {
      this.map.invalidateSize();
      this.renderMapTowers();
    } else {
      this.initMapPreview();
    }
  }

  private cleanupMap(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.map) {
      try {
        this.map.remove();
      } catch {}
      this.map = null;
      this.currentTileLayer = null;
    }
  }

  // --- Dispatch Action ---
  protected dispatchMission(): void {
    this.error.set('');

    if (this.form.invalid) {
      this.form.markAllAsTouched();
      const missing: string[] = [];
      const c = this.form.controls;
      if (c.name.invalid) missing.push('Tên đợt bay (tối thiểu 5 ký tự)');
      if (c.inspectorId.invalid) missing.push('Phi công phụ trách (Inspector)');
      if (c.droneId.invalid) missing.push('Phương tiện UAV');
      if (c.scheduledAt.invalid) missing.push('Thời điểm bắt đầu bay');
      if (c.plannedEnd.invalid) missing.push('Thời điểm kết thúc');
      if (c.confirmationDeadline.invalid) missing.push('Hạn chót xác nhận');

      this.error.set(`Vui lòng hoàn thiện các trường bắt buộc: ${missing.join(', ')}.`);
      if (typeof window !== 'undefined') {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
      return;
    }

    const f = this.form.getRawValue();
    const ass = this.assessmentData();
    const startTime = new Date(f.scheduledAt).getTime();
    const endTime = new Date(f.plannedEnd).getTime();
    const deadlineTime = new Date(f.confirmationDeadline).getTime();

    if (endTime <= startTime) {
      this.error.set('Thời gian kết thúc nhiệm vụ phải sau thời điểm bắt đầu bay.');
      if (typeof window !== 'undefined') {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
      return;
    }

    if (deadlineTime >= startTime) {
      this.error.set('Hạn chót Inspector xác nhận (Confirmation Deadline) phải diễn ra trước thời điểm bắt đầu bay.');
      if (typeof window !== 'undefined') {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
      return;
    }

    this.busy.set(true);
    this.error.set('');

    const targetAssetIds = ass ? ass.scopeAssetIds : ['VT-01', 'VT-02', 'VT-03'];
    const regionId = ass?.regionId || 'reg-cpc';
    const boundaryWkt = ass?.scopeGeometry ? JSON.stringify(ass.scopeGeometry) : '';

    const req: MissionCreateRequest = {
      name: f.name,
      description: f.description,
      scheduledAt: f.scheduledAt,
      plannedEnd: f.plannedEnd,
      regionId,
      missionType: 'SCHEDULED',
      inspectorId: f.inspectorId,
      droneId: f.droneId,
      targetAssetIds,
      boundaryWkt,
      confirmationDeadline: f.confirmationDeadline,
      managerInstructions: f.managerInstructions,
      sourceAssessmentId: ass?.id,
    };

    this.api
      .create(req)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (mission) => {
          this.busy.set(false);

          // Dispatch Notification to Header Notifications Store
          if (f.notifyInApp) {
            const inspectorName = this.selectedInspector()?.name || 'Phi công UAV';
            this.notificationsStore.upsert({
              id: `notif-${Date.now()}`,
              userId: f.inspectorId,
              type: 'MISSION_DISPATCH',
              referenceType: 'MISSION',
              referenceId: mission.id,
              title: `Phân công nhiệm vụ bay: ${mission.missionCode}`,
              body: `Bạn được phân công phụ trách nhiệm vụ "${mission.title}". Hạn chót xác nhận: ${new Date(f.confirmationDeadline).toLocaleTimeString('vi-VN')} ${new Date(f.confirmationDeadline).toLocaleDateString('vi-VN')}.`,
              createdAt: new Date().toISOString(),
              isRead: false,
            });
          }

          // Broadcast real-time mission dispatch event across tabs / roles
          this.realtime.broadcastMissionEvent({
            missionId: mission.id,
            type: 'DISPATCHED',
            status: 'PENDING_CONFIRMATION',
            actorRole: 'MANAGER',
            actorName: this.currentUser()?.fullName || 'Quản lý vận hành',
            managerInstructions: f.managerInstructions,
            confirmationDeadline: f.confirmationDeadline,
            timestamp: new Date().toISOString(),
          });

          // Mark assessment completed
          if (ass?.id) {
            this.preMissionApi.markCompleted(ass.id, mission.id).subscribe({
              error: () => {},
            });
          }

          // Route to Mission Detail
          this.router.navigate(['/missions', mission.id], {
            queryParams: { created: 'true' },
          });
        },
        error: (err) => {
          this.busy.set(false);
          this.error.set(err?.error?.message || 'Không thể tạo và ban hành nhiệm vụ bay. Vui lòng thử lại.');
        },
      });
  }
}
