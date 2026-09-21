import { DatePipe, Location } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import * as L from 'leaflet';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { Auth } from '../../../../core/auth/auth';
import {
  DroneTechnicalInspectionResult,
  PreMissionAssessment,
  UavCandidate,
} from '../../../../models/pre-mission.models';
import { statusLabel, statusTone } from '../../../../shared/status/status';
import { defaultSiteChecks, PreMissionApi, RealtimeWeatherSnapshot } from '../../data-access/pre-mission-api';

export type WorkspaceTab = 'overview' | 'site' | 'personnel' | 'uav' | 'technical';

@Component({
  selector: 'app-assessment-workspace',
  imports: [RouterLink, DatePipe, NzIconModule],
  templateUrl: './assessment-workspace.html',
  styleUrl: './assessment-workspace.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AssessmentWorkspace implements AfterViewInit, OnDestroy {
  private readonly api = inject(PreMissionApi);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly auth = inject(Auth);
  private readonly location = inject(Location);

  protected readonly scopeMapContainer = viewChild<ElementRef<HTMLDivElement>>('scopeMapContainer');
  protected readonly siteMapContainer = viewChild<ElementRef<HTMLDivElement>>('siteMapContainer');

  protected readonly currentUser = this.auth.user;
  protected readonly canManage = computed(() => {
    const role = this.currentUser()?.role;
    return !role || role === 'SystemAdmin' || role === 'Manager';
  });
  protected readonly canInspectDrone = computed(() => {
    const role = this.currentUser()?.role;
    return !role || role === 'SystemAdmin' || role === 'Technician' || role === 'Inspector' || role === 'Manager';
  });

  protected readonly item = signal<PreMissionAssessment | null>(null);
  protected readonly error = signal('');
  protected readonly actionMessage = signal('');
  protected readonly isStaleConflict = signal(false);
  protected readonly busy = signal(false);
  protected readonly activeTab = signal<WorkspaceTab>('overview');

  // Personnel filter in Tab 3
  protected readonly personnelSearch = signal('');

  // Drone Technical Inspection in Tab 5
  protected readonly selectedDroneId = signal<string>('');
  protected readonly inspectionResult = signal<DroneTechnicalInspectionResult | null>(null);
  protected readonly inspecting = signal(false);

  // Real-time weather observation
  protected readonly realtimeWeather = signal<RealtimeWeatherSnapshot | null>(null);
  protected readonly loadingWeather = signal(false);

  // Leaflet map
  private map: L.Map | null = null;
  private currentTileLayer: L.TileLayer | null = null;
  private markersLayer = L.layerGroup();
  private polylineLayer = L.layerGroup();
  private bufferLayer = L.layerGroup();
  private resizeObserver: ResizeObserver | null = null;
  protected readonly currentMapType = signal<'google-streets' | 'google-hybrid' | 'google-terrain' | 'carto'>('google-streets');

  protected readonly isReady = computed(() => {
    const a = this.item();
    return a?.status === 'READY';
  });

  protected readonly isExpired = computed(() => {
    const a = this.item();
    if (!a || !a.validUntil) return false;
    return new Date(a.validUntil).getTime() < Date.now();
  });

  protected readonly isEvaluating = computed(() => {
    return this.item()?.status === 'EVALUATING';
  });

  protected readonly isCancelled = computed(() => {
    return this.item()?.status === 'CANCELLED';
  });

  protected readonly isConsumed = computed(() => {
    return this.item()?.status === 'CONSUMED';
  });

  protected readonly canProceedToMf02 = computed(() => {
    return this.isReady() && !this.isExpired() && !this.isConsumed() && !this.isCancelled();
  });

  protected readonly failedConditions = computed(() => {
    const a = this.item();
    if (!a) return [];
    const list: { pillar: string; reason: string; actionTab: WorkspaceTab; actionLabel: string }[] = [];

    if (a.site.status !== 'PASS' && a.site.status !== 'FEASIBLE') {
      list.push({
        pillar: 'Mặt bằng & Khí tượng',
        reason: a.site.reason || 'Điều kiện sức gió vượt ngưỡng an toàn cho phép hoặc khoảng cách hành lang chưa đảm bảo.',
        actionTab: 'site',
        actionLabel: 'Xem chi tiết mặt bằng & khí tượng',
      });
    }

    if (a.personnel.status !== 'PASS' && a.personnel.status !== 'READY') {
      list.push({
        pillar: 'Nhân sự vận hành',
        reason: a.personnel.reason || 'Chưa có đủ ứng viên phi công / cán bộ giám sát đạt chuẩn khả dụng.',
        actionTab: 'personnel',
        actionLabel: 'Kiểm tra ứng viên nhân sự',
      });
    }

    if (a.uav.status !== 'PASS' && a.uav.status !== 'READY') {
      list.push({
        pillar: 'Phương tiện UAV',
        reason: a.uav.reason || 'Chưa có UAV nào đạt hạn kiểm định hoặc khả dụng trong khung giờ này.',
        actionTab: 'uav',
        actionLabel: 'Xem danh sách thiết bị bay',
      });
    }

    if (a.technical.status !== 'PASS' && a.technical.status !== 'HEALTHY') {
      list.push({
        pillar: 'Sức khỏe kỹ thuật',
        reason: a.technical.reason || 'Cần thực hiện kiểm định kỹ thuật tự động (BIST/Telemetry) trước khi bay.',
        actionTab: 'technical',
        actionLabel: 'Chạy kiểm định kỹ thuật',
      });
    }

    return list;
  });

  protected readonly filteredPersonnel = computed(() => {
    const a = this.item();
    if (!a) return [];
    const q = this.personnelSearch().trim().toLowerCase();
    if (!q) return a.personnelCandidates;
    return a.personnelCandidates.filter(
      (p) => p.name.toLowerCase().includes(q) || p.role.toLowerCase().includes(q) || (p.region && p.region.toLowerCase().includes(q))
    );
  });

  constructor() {
    this.load();

    // Reactive effect: mount or update map as soon as assessment data is loaded and DOM container is rendered
    effect(() => {
      const a = this.item();
      const tab = this.activeTab();
      const scopeEl = this.scopeMapContainer();
      const siteEl = this.siteMapContainer();
      if (a && (tab === 'overview' || tab === 'site') && (scopeEl || siteEl)) {
        setTimeout(() => this.initOrUpdateMap(), 60);
      }
    });
  }

  ngAfterViewInit(): void {
    if (this.activeTab() === 'overview' || this.activeTab() === 'site') {
      setTimeout(() => this.initOrUpdateMap(), 150);
    }
  }

  ngOnDestroy(): void {
    this.cleanupMap();
  }

  protected load(): void {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      this.error.set('Không tìm thấy mã định danh đánh giá.');
      return;
    }
    this.busy.set(true);
    this.isStaleConflict.set(false);
    this.error.set('');
    this.api.get(id).subscribe({
      next: (res) => {
        this.item.set(res);
        if (res.uavCandidates.length > 0 && !this.selectedDroneId()) {
          this.selectedDroneId.set(res.uavCandidates[0].id || res.uavCandidates[0].code);
        }
        if (res.droneInspection) {
          this.inspectionResult.set(res.droneInspection);
        }
        this.loadWeatherForAssessment(res);
        setTimeout(() => this.initOrUpdateMap(), 200);
      },
      error: () => {
        this.error.set('Đánh giá tiền nhiệm vụ không tồn tại hoặc bạn không có quyền truy cập.');
      },
      complete: () => {
        this.busy.set(false);
      },
    });
  }

  protected goBack(): void {
    if (window.history.length > 1) {
      this.location.back();
    } else {
      this.router.navigate(['/pre-mission']);
    }
  }

  private loadWeatherForAssessment(a: PreMissionAssessment): void {
    let lat = 16.0544;
    let lng = 108.2022;
    const reg = (a.regionName || a.regionId || '').toLowerCase();
    if (reg.includes('bắc') || reg.includes('north') || reg.includes('hn') || reg.includes('npc')) {
      lat = 21.0285;
      lng = 105.8542;
    } else if (reg.includes('nam') || reg.includes('south') || reg.includes('hcm') || reg.includes('spc')) {
      lat = 10.8231;
      lng = 106.6297;
    } else if (reg.includes('trung') || reg.includes('central') || reg.includes('cpc') || reg.includes('dn')) {
      lat = 16.0544;
      lng = 108.2022;
    }

    this.loadingWeather.set(true);
    this.api.getRealtimeWeather(lat, lng).subscribe({
      next: (weather) => {
        this.realtimeWeather.set(weather);
        this.loadingWeather.set(false);

        // Update site checks with live weather & configured corridor buffer
        const geom = (a.scopeGeometry && typeof a.scopeGeometry === 'object' ? a.scopeGeometry : {}) as Record<string, unknown>;
        const buf = Number(geom['corridorBufferMeters'] ?? 50);
        const alt = Number(geom['maxFlightAltitudeMeters'] ?? 120);
        const updatedChecks = defaultSiteChecks(weather.isSafeToFly, buf, alt, weather);
        this.item.update((curr) => (curr ? { ...curr, siteChecks: updatedChecks } : curr));
      },
      error: () => {
        this.loadingWeather.set(false);
      },
    });
  }

  protected reevaluate(): void {
    const a = this.item();
    if (!a || this.busy()) return;
    this.busy.set(true);
    this.actionMessage.set('');
    this.error.set('');
    this.isStaleConflict.set(false);

    this.api.reEvaluate(a.id).subscribe({
      next: (updated) => {
        this.item.set(updated);
        this.actionMessage.set('Đã hoàn tất đánh giá lại tính khả thi và tài nguyên.');
      },
      error: (err) => {
        if (err?.status === 409) {
          this.isStaleConflict.set(true);
          this.error.set('Dữ liệu đánh giá đã bị thay đổi bởi phiên làm việc khác (HTTP 409 Conflict). Vui lòng bấm "Làm mới dữ liệu" để tải thông tin mới nhất.');
        } else {
          this.error.set(err?.error?.message || 'Không thể thực hiện đánh giá lại. Vui lòng thử lại sau.');
        }
      },
      complete: () => {
        this.busy.set(false);
      },
    });
  }

  protected cancelAssessment(): void {
    const a = this.item();
    if (!a || this.busy()) return;
    if (a.status === 'CONSUMED') {
      this.error.set('Không thể hủy đánh giá đã được chuyển tiếp tạo nhiệm vụ.');
      return;
    }

    const confirmed = window.confirm(`Bạn có chắc muốn hủy bản đánh giá tiền nhiệm vụ ${a.assessmentCode}? Thao tác này không thể đảo ngược.`);
    if (!confirmed) return;

    this.busy.set(true);
    this.error.set('');
    this.isStaleConflict.set(false);
    this.api.cancel(a.id, 'Người dùng hủy tại trang chi tiết').subscribe({
      next: (updated) => {
        this.item.set(updated);
        this.actionMessage.set(`Đã hủy bản đánh giá ${a.assessmentCode}.`);
      },
      error: (err) => {
        if (err?.status === 409) {
          this.isStaleConflict.set(true);
          this.error.set('Dữ liệu đánh giá đã bị thay đổi bởi phiên làm việc khác (HTTP 409 Conflict). Vui lòng bấm "Làm mới dữ liệu".');
        } else {
          this.error.set(err?.error?.message || 'Không thể hủy bản đánh giá.');
        }
      },
      complete: () => {
        this.busy.set(false);
      },
    });
  }

  protected setTab(tab: WorkspaceTab): void {
    this.activeTab.set(tab);
    if (tab === 'overview' || tab === 'site') {
      setTimeout(() => this.initOrUpdateMap(), 150);
    } else {
      this.cleanupMap();
      if (tab === 'technical') {
        const droneId = this.selectedDroneId();
        if (droneId && !this.inspectionResult()) {
          this.loadLatestInspection(droneId);
        }
      }
    }
  }

  protected selectDroneForInspection(drone: UavCandidate): void {
    const droneId = drone.id || drone.code;
    this.selectedDroneId.set(droneId);
    this.setTab('technical');
    this.loadLatestInspection(droneId);
  }

  protected loadLatestInspection(droneId: string): void {
    this.inspecting.set(true);
    this.api.getLatestTechnicalInspection(droneId).subscribe({
      next: (res) => {
        this.inspectionResult.set(res);
        this.inspecting.set(false);
      },
      error: () => {
        this.inspecting.set(false);
      },
    });
  }

  protected runInspectionNow(): void {
    const droneId = this.selectedDroneId() || (this.item()?.uavCandidates[0]?.id ?? 'UAV-01');
    this.inspecting.set(true);
    this.actionMessage.set('');
    this.error.set('');

    this.api.runTechnicalInspection(droneId).subscribe({
      next: (res) => {
        this.inspectionResult.set(res);
        this.inspecting.set(false);
        this.actionMessage.set(`Đã hoàn tất kiểm định kỹ thuật cho thiết bị ${res.droneCode}. Kết quả: ${res.overallHealth}.`);

        // If inspection passes, trigger re-evaluation to update assessment overall status
        const a = this.item();
        if (a && res.overallHealth === 'HEALTHY') {
          this.api.reEvaluate(a.id).subscribe({
            next: (updated) => this.item.set(updated),
          });
        }
      },
      error: () => {
        this.inspecting.set(false);
        this.error.set('Lỗi kết nối khi gửi lệnh kiểm định UAV.');
      },
    });
  }

  protected setMapType(type: 'google-streets' | 'google-hybrid' | 'google-terrain' | 'carto'): void {
    this.currentMapType.set(type);
    if (!this.map) return;

    if (this.currentTileLayer) {
      this.map.removeLayer(this.currentTileLayer);
      this.currentTileLayer = null;
    }

    let tileUrl: string;
    let maxZoom = 20;
    let subdomains = ['mt0', 'mt1', 'mt2', 'mt3'];
    let attribution = '© Google Maps | UAV-PMS GIS';

    switch (type) {
      case 'google-hybrid':
        tileUrl = 'https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}';
        attribution = '© Google Maps Vệ Tinh | UAV-PMS GIS';
        break;
      case 'google-terrain':
        tileUrl = 'https://{s}.google.com/vt/lyrs=p&x={x}&y={y}&z={z}';
        attribution = '© Google Maps Địa Hình | UAV-PMS GIS';
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
        attribution = '© Google Maps | UAV-PMS GIS';
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

    // Resilient fallback: If Google tile endpoint fails or is blocked, switch seamlessly to CartoDB Voyager
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

  private initOrUpdateMap(): void {
    const container = (this.activeTab() === 'overview'
      ? (this.scopeMapContainer()?.nativeElement ?? document.getElementById('workspaceScopeMapContainer'))
      : (this.siteMapContainer()?.nativeElement ?? document.getElementById('workspaceSiteMapContainer'))) as HTMLDivElement | null;
    if (!container) return;

    if (this.map) {
      if (this.map.getContainer() !== container) {
        this.cleanupMap();
      }
    }

    if (!this.map) {
      if ((container as any)._leaflet_id) {
        (container as any)._leaflet_id = null;
      }

      this.map = L.map(container, {
        center: [16.0544, 108.2022],
        zoom: 13,
        zoomControl: true,
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
    }

    this.map.whenReady(() => {
      this.map?.invalidateSize();
      this.renderScopeOnMap();
    });

    setTimeout(() => {
      this.map?.invalidateSize();
      this.renderScopeOnMap();
    }, 80);

    setTimeout(() => {
      this.map?.invalidateSize();
    }, 280);
  }

  private renderScopeOnMap(): void {
    if (!this.map) return;
    this.markersLayer.clearLayers();
    this.polylineLayer.clearLayers();
    this.bufferLayer.clearLayers();

    const a = this.item();
    if (!a || !a.scopeAssetIds || a.scopeAssetIds.length === 0) return;

    const geom = (a.scopeGeometry && typeof a.scopeGeometry === 'object' ? a.scopeGeometry : {}) as Record<string, unknown>;
    const bufferMeters = Number(geom['corridorBufferMeters'] ?? 50);

    // Determine region anchor coordinates
    let baseLat = 16.0544;
    let baseLng = 108.2022;
    const reg = (a.regionName || a.regionId || '').toLowerCase();
    if (reg.includes('bắc') || reg.includes('north') || reg.includes('hn') || reg.includes('npc')) {
      baseLat = 21.0285;
      baseLng = 105.8542;
    } else if (reg.includes('nam') || reg.includes('south') || reg.includes('hcm') || reg.includes('spc')) {
      baseLat = 10.8231;
      baseLng = 106.6297;
    } else if (reg.includes('trung') || reg.includes('central') || reg.includes('cpc') || reg.includes('dn')) {
      baseLat = 16.0544;
      baseLng = 108.2022;
    }

    const latLngs: [number, number][] = [];

    a.scopeAssetIds.forEach((code, idx) => {
      const lat = baseLat + idx * 0.0045;
      const lng = baseLng + idx * 0.0065;
      latLngs.push([lat, lng]);

      // Safety buffer circle around tower
      const circle = L.circle([lat, lng], {
        radius: bufferMeters,
        color: '#0284c7',
        fillColor: '#38bdf8',
        fillOpacity: 0.18,
        weight: 1.5,
        dashArray: '4, 4',
      });
      this.bufferLayer.addLayer(circle);

      // Circle marker for tower
      const marker = L.circleMarker([lat, lng], {
        radius: 7,
        fillColor: '#0052cc',
        color: '#ffffff',
        weight: 2,
        fillOpacity: 1,
      });

      marker.bindPopup(`
        <div style="font-family: inherit; font-size: 11px; line-height: 1.4;">
          <strong style="color: #003f99;">Vị trí cột: ${code}</strong><br/>
          <span>Tuyến: ${a.lineName || 'Theo danh mục khảo sát'}</span><br/>
          <span>Tọa độ: ${lat.toFixed(5)}, ${lng.toFixed(5)}</span><br/>
          <span>Hành lang an toàn: ${bufferMeters}m</span>
        </div>
      `);
      marker.bindTooltip(code, { permanent: true, direction: 'top', className: 'evn-map-tooltip', offset: [0, -6] });
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
      this.map.fitBounds(bounds, { padding: [35, 35], maxZoom: 16 });
    }
  }

  protected refreshMap(): void {
    if (this.map) {
      this.map.invalidateSize();
      this.renderScopeOnMap();
    } else {
      this.initOrUpdateMap();
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

  protected statusTone = statusTone;
  protected statusLabel = statusLabel;
}
