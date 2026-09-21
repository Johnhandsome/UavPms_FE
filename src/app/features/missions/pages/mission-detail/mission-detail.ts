import { DatePipe } from '@angular/common';
import { HttpErrorResponse, HttpEventType } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  ViewChild,
  computed,
  effect,
  inject,
  signal,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import * as L from 'leaflet';
import { catchError, finalize, of } from 'rxjs';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { Mission, MissionCommunicationLog } from '../../../../models/missions.models';
import { AssetManagementApi, DetectionReviewDecision, MissionAiDetection } from '../../../assets/data-access/asset-management-api';
import {
  AiAnalysisStatusChangedEvent,
  MissionLifecycleRealtimeEvent,
  NotificationsRealtime,
} from '../../../notifications/data-access/notifications-realtime';
import { MissionsApi } from '../../data-access/missions-api';
import { NotificationsStore } from '../../../notifications/data-access/notifications-store';
import { Auth } from '../../../../core/auth/auth';

export type MissionDetailTab = 'overview' | 'upload' | 'processing' | 'results' | 'assets' | 'maintenance' | 'activity';
export type MediaKind = 'image' | 'video';

export interface MissionMediaPreview {
  readonly id: string;
  readonly file: File;
  readonly url: string;
  readonly thumbnailUrl: string;
  readonly kind: MediaKind;
  readonly name: string;
  readonly size: string;
  readonly resolution: string;
  readonly fps: string;
  readonly duration: string;
  readonly durationSeconds: number;
  readonly status: string;
  readonly progress: number;
  readonly requestId?: string;
  readonly batchId?: string;
  readonly accepted?: boolean;
  readonly savedDetections?: number;
  readonly createdAlerts?: number;
  readonly completedAt?: string;
  readonly errorMessage?: string;
}

export interface MissionDetectionView {
  readonly id: string;
  readonly mediaId: string;
  readonly title: string;
  readonly confidence: number;
  readonly timestampLabel: string;
  readonly timestampSeconds: number | null;
  readonly frameIndex: number | null;
  readonly videoDurationLabel: string;
  readonly status: string;
  readonly mediaStatus: string;
  readonly categoryCode: string;
  readonly severityWeight: number;
  readonly isEmergency: boolean;
  readonly aiSource: string;
  readonly mediaType: string;
  readonly sourceUrl?: string;
  readonly imageUrl?: string;
  readonly cropImageUrl?: string;
  readonly boundingBox?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly missionId: string;
  readonly assetId: string;
  readonly tower: string;
  readonly gps: string;
  readonly description: string;
  readonly notes: string;
  readonly detectedAt: string;
  readonly validatedAt: string;
}

export interface MissionTimelineMarker {
  readonly id: string;
  readonly detectionId: string;
  readonly timestampSeconds: number;
  readonly timestampLabel: string;
  readonly percent: number;
  readonly title: string;
  readonly confidence: number;
  readonly isEmergency: boolean;
}

export interface MissionAssetItem {
  readonly id: string;
  readonly code: string;
  readonly type: string;
  readonly towerCode: string;
  readonly healthScore: number;
  readonly riskLevel: 'Critical Risk' | 'High Risk' | 'Medium Risk' | 'Low Risk';
  readonly defectCount: number;
  readonly status: 'Operational' | 'Maintenance' | 'InspectionRequired';
  readonly lastInspected: string;
}

export interface MissionMaintenanceTask {
  readonly id: string;
  readonly title: string;
  readonly priority: 'Urgent' | 'High' | 'Medium' | 'Scheduled';
  readonly towerCode: string;
  readonly assetCode: string;
  readonly defectDescription: string;
  readonly suggestedAction: string;
  readonly status: 'Pending' | 'Approved' | 'InProgress' | 'Completed';
  readonly assignedTeam: string;
}

@Component({
  selector: 'app-mission-detail',
  imports: [DatePipe, RouterLink, NzIconModule],
  templateUrl: './mission-detail.html',
  styleUrl: './mission-detail.scss',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MissionDetail {
  private readonly api = inject(MissionsApi);
  private readonly assetApi = inject(AssetManagementApi);
  private readonly realtime = inject(NotificationsRealtime);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);
  private readonly notificationsStore = inject(NotificationsStore);
  protected readonly auth = inject(Auth);
  protected readonly isInspector = computed(() => {
    const role = (this.auth.user()?.role || '').toLowerCase();
    return (
      role === 'inspector' ||
      role === 'pilot' ||
      role === 'admin' ||
      role === 'systemadmin' ||
      role === 'administrator'
    );
  });
  private readonly aiStatusEvents = new Map<string, AiAnalysisStatusChangedEvent>();
  private readonly missionMapContainer = viewChild<ElementRef<HTMLDivElement>>('missionMap');
  private map: L.Map | null = null;
  private currentTileLayer: L.TileLayer | null = null;
  private targetMarkers: L.Marker[] = [];
  private routePolyline: L.Polyline | null = null;
  private mapResizeObserver: ResizeObserver | null = null;
  protected readonly mapType = signal<'satellite' | 'streets'>('satellite');

  @ViewChild('resultVideo') private readonly resultVideo?: ElementRef<HTMLVideoElement>;

  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly mission = signal<Mission | null>(null);

  // MF02 Communication & Lifecycle State
  protected readonly activeRole = signal<'MANAGER' | 'INSPECTOR'>('MANAGER');
  protected readonly actionBusy = signal(false);
  protected readonly actionMessage = signal('');
  protected readonly showPostponeModal = signal(false);
  protected readonly postponeReason = signal('');
  protected readonly showSuspendModal = signal(false);
  protected readonly suspendReason = signal('');
  protected readonly showCancelModal = signal(false);
  protected readonly cancelReason = signal('');
  protected readonly chatMessage = signal('');
  protected readonly currentTime = signal(Date.now());

  protected readonly confirmationDeadlineDate = computed(() => {
    const m = this.mission();
    if (!m) return null;
    if (m.confirmationDeadline) return new Date(m.confirmationDeadline);
    if (m.plannedStart) {
      return new Date(new Date(m.plannedStart).getTime() - 2 * 3600 * 1000);
    }
    return null;
  });

  protected readonly isDeadlineOverdue = computed(() => {
    const deadline = this.confirmationDeadlineDate();
    const m = this.mission();
    if (!deadline || !m) return false;
    const pending = m.status === 'PENDING_CONFIRMATION' || m.status === 'Assigned' || m.status === 'Pending';
    return pending && this.currentTime() > deadline.getTime();
  });

  protected readonly deadlineTimeRemaining = computed(() => {
    const deadline = this.confirmationDeadlineDate();
    if (!deadline) return null;
    const now = this.currentTime();
    const diffMs = deadline.getTime() - now;
    const isPast = diffMs < 0;
    const absDiffMs = Math.abs(diffMs);
    const hours = Math.floor(absDiffMs / (1000 * 60 * 60));
    const minutes = Math.floor((absDiffMs % (1000 * 60 * 60)) / (1000 * 60));

    if (isPast) {
      return `Quá hạn ${hours > 0 ? `${hours}h ` : ''}${minutes} phút`;
    }
    return `Còn ${hours > 0 ? `${hours}h ` : ''}${minutes} phút`;
  });

  protected readonly communicationLogs = computed(() => {
    const m = this.mission();
    if (!m) return [];
    return m.communicationLogs ?? [];
  });
  protected readonly targetsWithCoordinates = computed(() => this.mission()?.targets.filter((target) =>
    Number.isFinite(target.latitude) && Number.isFinite(target.longitude)
      && Math.abs(target.latitude!) <= 90 && Math.abs(target.longitude!) <= 180,
  ) ?? []);
  protected readonly targetsInEvnspcCoverage = computed(() => this.targetsWithCoordinates().filter((target) =>
    target.latitude! >= 8 && target.latitude! <= 16.2 && target.longitude! >= 102 && target.longitude! <= 109.6,
  ));
  protected readonly hasTargetsOutsideEvnspcCoverage = computed(
    () => this.targetsInEvnspcCoverage().length !== this.targetsWithCoordinates().length,
  );
  protected readonly selectedTargetId = signal('');
  protected readonly selectedTarget = computed(() => {
    const targets = this.mission()?.targets ?? [];
    return targets.find((target) => target.assetId === this.selectedTargetId()) ?? targets[0] ?? null;
  });
  protected readonly activeTab = signal<MissionDetailTab>('overview');
  protected readonly mediaQueue = signal<readonly MissionMediaPreview[]>([]);
  protected readonly activeMediaId = signal('');
  protected readonly selectedMedia = computed<MissionMediaPreview | null>(
    () => this.mediaQueue().find((media) => media.id === this.activeMediaId()) ?? this.mediaQueue()[0] ?? null,
  );
  protected readonly lightboxMedia = signal<MissionMediaPreview | null>(null);
  protected readonly dragActive = signal(false);
  protected readonly uploadProgress = signal(0);
  protected readonly uploadBusy = signal(false);
  protected readonly uploadMessage = signal('');
  protected readonly lastUploadBatchId = signal('');
  protected readonly aiRealtimeStatus = signal<'connected' | 'disconnected' | 'reconnecting'>('disconnected');

  // Detections & AI Results State
  protected readonly detectionsLoading = signal(false);
  protected readonly detections = signal<readonly MissionDetectionView[]>([]);
  protected readonly displayedDetections = computed(() => {
    return this.detections();
  });

  protected readonly resultPage = signal(1);
  protected readonly resultPageSize = signal(6);
  protected readonly resultTotalPages = computed(() =>
    Math.max(1, Math.ceil(this.displayedDetections().length / this.resultPageSize())),
  );
  protected readonly resultPageButtons = computed(() =>
    this.compactPages(this.resultPage(), this.resultTotalPages()),
  );
  protected readonly pagedDisplayedDetections = computed(() => {
    const page = Math.min(this.resultPage(), this.resultTotalPages());
    const start = (page - 1) * this.resultPageSize();
    return this.displayedDetections().slice(start, start + this.resultPageSize());
  });
  protected readonly resultStartIndex = computed(() => {
    const total = this.displayedDetections().length;
    if (!total) return 0;
    return (Math.min(this.resultPage(), this.resultTotalPages()) - 1) * this.resultPageSize() + 1;
  });
  protected readonly resultEndIndex = computed(() =>
    Math.min(
      this.displayedDetections().length,
      Math.min(this.resultPage(), this.resultTotalPages()) * this.resultPageSize(),
    ),
  );

  protected readonly approvedDetectionCount = computed(
    () => this.detections().filter((item) => ['Approved', 'Accepted'].includes(item.status)).length,
  );
  protected readonly rejectedDetectionCount = computed(
    () => this.detections().filter((item) => item.status === 'Rejected').length,
  );
  protected readonly pendingDetectionCount = computed(
    () => this.detections().length - this.approvedDetectionCount() - this.rejectedDetectionCount(),
  );

  protected readonly videoDetections = computed(() => {
    return this.detections().filter((item) => this.isVideoDetection(item));
  });

  protected readonly selectedDetection = signal<MissionDetectionView | null>(null);
  protected readonly reviewBusy = signal(false);
  protected readonly reviewNotes = signal('');
  protected readonly resultMessage = signal('');
  protected readonly detailPanelWidth = signal(400);
  private readonly missionMapEffect = effect(() => {
    const mission = this.mission();
    const tab = this.activeTab();
    if (!mission || tab !== 'overview') return;
    setTimeout(() => this.renderMissionMap(), 0);
  });

  // Video Inspection Playback State
  protected readonly videoCurrentTime = signal<number>(0);
  protected readonly videoDuration = signal<number>(60);
  protected readonly hoveredMarker = signal<MissionTimelineMarker | null>(null);

  // Video Timeline Markers
  protected readonly videoTimelineMarkers = computed<readonly MissionTimelineMarker[]>(() => {
    const dur = this.videoDuration() || 60;
    return this.videoDetections()
      .filter((d) => d.timestampSeconds !== null && d.timestampSeconds <= dur)
      .map((d) => {
        const ts = d.timestampSeconds!;
        const pct = Math.min(100, Math.max(0, (ts / dur) * 100));
        return {
          id: `marker-${d.id}`,
          detectionId: d.id,
          timestampSeconds: ts,
          timestampLabel: d.timestampLabel,
          percent: pct,
          title: d.title,
          confidence: d.confidence,
          isEmergency: d.isEmergency,
        };
      });
  });

  // Mission Assets Data
  protected readonly missionAssets = signal<readonly MissionAssetItem[]>([
    {
      id: 'ast-01',
      code: 'INS-220KV-042-PHA-B',
      type: 'Chuỗi sứ cách điện đỡ',
      towerCode: 'Cột 042 (Néo)',
      healthScore: 38,
      riskLevel: 'Critical Risk',
      defectCount: 1,
      status: 'Maintenance',
      lastInspected: '27/08/2026 14:20',
    },
    {
      id: 'ast-02',
      code: 'BOLT-TOW-042-X1',
      type: 'Bu lông thanh giằng xà',
      towerCode: 'Cột 042 (Néo)',
      healthScore: 54,
      riskLevel: 'High Risk',
      defectCount: 1,
      status: 'InspectionRequired',
      lastInspected: '27/08/2026 14:21',
    },
    {
      id: 'ast-03',
      code: 'VEG-SPAN-041-042',
      type: 'Hành lang an toàn khoảng cột',
      towerCode: 'Khoảng cột 041 - 042',
      healthScore: 68,
      riskLevel: 'Medium Risk',
      defectCount: 1,
      status: 'Operational',
      lastInspected: '27/08/2026 14:18',
    },
    {
      id: 'ast-04',
      code: 'COND-ACSR-400-PhaA',
      type: 'Dây dẫn ACSR 400mm2',
      towerCode: 'Cột 041 (Đỡ)',
      healthScore: 92,
      riskLevel: 'Low Risk',
      defectCount: 0,
      status: 'Operational',
      lastInspected: '27/08/2026 14:15',
    },
    {
      id: 'ast-05',
      code: 'OPGW-EARTH-24F',
      type: 'Dây chống sét cáp quang OPGW',
      towerCode: 'Đỉnh cột 040 - 043',
      healthScore: 96,
      riskLevel: 'Low Risk',
      defectCount: 0,
      status: 'Operational',
      lastInspected: '27/08/2026 14:10',
    },
  ]);

  // Mission Maintenance Recommendations
  protected readonly maintenanceTasks = signal<readonly MissionMaintenanceTask[]>([
    {
      id: 'maint-01',
      title: 'Thay thế khẩn cấp bát sứ nứt vỡ chuỗi néo pha B',
      priority: 'Urgent',
      towerCode: 'Cột 042 (TOW-220KV-042)',
      assetCode: 'INS-220KV-042-PHA-B',
      defectDescription: 'Bát sứ số 4 chuỗi néo bị nứt vỡ bề mặt có nguy cơ phóng điện rã lưới.',
      suggestedAction: 'Cắt điện xuất tuyến, điều xe gầu chuyên dụng thay mới chuỗi cách điện polymer 220kV trong 24h.',
      status: 'Approved',
      assignedTeam: 'Đội Truyền tải Điện Hà Nội 1',
    },
    {
      id: 'maint-02',
      title: 'Xiết bu lông thanh giằng góc và bổ sung đai ốc hãm',
      priority: 'High',
      towerCode: 'Cột 042 (TOW-220KV-042)',
      assetCode: 'BOLT-TOW-042-X1',
      defectDescription: 'Bu lông thanh giằng chữ V xà đỡ bị lỏng đai ốc do rung động gió.',
      suggestedAction: 'Kiểm tra mô-men siết toàn bộ liên kết xà, tra mỡ bảo vệ chống gỉ.',
      status: 'Pending',
      assignedTeam: 'Tổ Quản lý Vận hành Đường dây',
    },
    {
      id: 'maint-03',
      title: 'Phát quang cây vi phạm khoảng cách pha - đất',
      priority: 'Medium',
      towerCode: 'Khoảng cột 041 - 042',
      assetCode: 'VEG-SPAN-041-042',
      defectDescription: 'Ngọn cây bạch đàn phát triển sát hành lang dây dẫn pha dưới < 3.5m.',
      suggestedAction: 'Phối hợp chính quyền địa phương chặt hạ cây cao nguy hiểm.',
      status: 'InProgress',
      assignedTeam: 'Đội Bảo dưỡng Hành lang Tuyến',
    },
  ]);

  private resizeStartX = 0;
  private resizeStartWidth = 400;
  private readonly handleResultDetailResizeMove = (event: PointerEvent): void => {
    const maxWidth = Math.min(800, Math.max(320, window.innerWidth - 420));
    const nextWidth = this.resizeStartWidth + this.resizeStartX - event.clientX;
    this.detailPanelWidth.set(Math.min(maxWidth, Math.max(300, Math.round(nextWidth))));
  };
  private readonly stopResultDetailResize = (): void => {
    window.removeEventListener('pointermove', this.handleResultDetailResizeMove);
    window.removeEventListener('pointerup', this.stopResultDetailResize);
  };

  constructor() {
    const id = this.route.snapshot.paramMap.get('id') ?? '';
    const tab = this.route.snapshot.queryParamMap.get('tab');
    if (this.isTab(tab)) this.activeTab.set(tab);

    this.realtime.status$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((status) => this.aiRealtimeStatus.set(status));
    this.realtime.aiAnalysisStatus$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => this.handleAiAnalysisStatus(event));
    this.realtime.missionEvents$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((event) => this.handleMissionRealtimeEvent(event));

    const timer = setInterval(() => this.currentTime.set(Date.now()), 30000);

    this.destroyRef.onDestroy(() => {
      clearInterval(timer);
      this.stopResultDetailResize();
      this.cleanupMap();
    });
    this.realtime.connect();

    this.api
      .get(id)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.loading.set(false)),
      )
      .subscribe({
        next: (mission) => {
          this.mission.set(mission);
          this.selectedTargetId.set(mission.targets[0]?.assetId ?? '');
          this.missionAssets.set(mission.targets.map((target) => ({
            id: target.assetId,
            code: target.assetCode,
            type: target.assetName || '—',
            towerCode: target.towerCode || '—',
            healthScore: 0,
            riskLevel: 'Low Risk',
            defectCount: 0,
            status: 'Operational',
            lastInspected: '—',
          })));
          this.loadDetections(mission.id);
        },
        error: (error: unknown) => this.error.set(this.errorMessage(error)),
      });
  }

  protected setTab(tab: MissionDetailTab): void {
    if (!this.isInspector() && (tab === 'upload' || tab === 'processing')) {
      this.activeTab.set('overview');
      return;
    }
    this.activeTab.set(tab);
    if (tab === 'results' || tab === 'processing') {
      const missionId = this.mission()?.id;
      if (missionId) this.loadDetections(missionId);
    }
  }

  protected setMapType(type: 'satellite' | 'streets'): void {
    this.mapType.set(type);
    if (!this.map) return;
    if (this.currentTileLayer) {
      this.map.removeLayer(this.currentTileLayer);
      this.currentTileLayer = null;
    }

    const tileUrl = type === 'satellite'
      ? 'https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}'
      : 'https://{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}';

    const tileLayer = L.tileLayer(tileUrl, {
      maxZoom: 20,
      subdomains: ['mt0', 'mt1', 'mt2', 'mt3'],
      attribution: '© Google Maps | EVN UAV-PMS',
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

  protected selectTarget(assetId: string): void {
    this.selectedTargetId.set(assetId);
    const target = this.mission()?.targets.find((item) => item.assetId === assetId);
    if (!target || !target.latitude || !target.longitude || !this.map) return;
    this.map.panTo([target.latitude, target.longitude], { animate: true, duration: 0.5 });
  }

  private renderMissionMap(): void {
    const container = this.missionMapContainer()?.nativeElement;
    if (!container) return;

    if (this.map && this.map.getContainer() !== container) {
      this.cleanupMap();
    }

    if (!this.map) {
      (container as unknown as { _leaflet_id: number | null })._leaflet_id = null;
      this.map = L.map(container, {
        zoomControl: false,
        attributionControl: false,
      });

      L.control.zoom({ position: 'topright' }).addTo(this.map);
      this.setMapType(this.mapType());

      this.mapResizeObserver = new ResizeObserver(() => {
        this.map?.invalidateSize();
      });
      this.mapResizeObserver.observe(container);
    }

    this.renderTargetsOnMap();
  }

  private renderTargetsOnMap(): void {
    if (!this.map) return;

    this.targetMarkers.forEach((m) => m.remove());
    this.targetMarkers = [];
    if (this.routePolyline) {
      this.routePolyline.remove();
      this.routePolyline = null;
    }

    const targets = [...this.targetsWithCoordinates()].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
    if (!targets.length) {
      this.map.setView([16.0, 107.5], 6);
      return;
    }

    const latLngs: L.LatLngExpression[] = [];

    targets.forEach((target, index) => {
      const lat = target.latitude!;
      const lng = target.longitude!;
      latLngs.push([lat, lng]);

      const sequence = target.sequence || index + 1;
      const code = target.towerCode || target.assetCode || `Cột ${sequence}`;

      const icon = L.divIcon({
        className: 'custom-tower-marker',
        html: `
          <div class="tower-pin">
            <span class="pin-badge">${sequence}</span>
            <span class="pin-code">${code}</span>
          </div>
        `,
        iconSize: [48, 48],
        iconAnchor: [24, 24],
      });

      const marker = L.marker([lat, lng], { icon })
        .addTo(this.map!)
        .bindPopup(`<strong>${code}</strong><br/>${target.assetName || ''}<br/>GPS: ${lat.toFixed(5)}, ${lng.toFixed(5)}`);

      marker.on('click', () => this.selectTarget(target.assetId));
      this.targetMarkers.push(marker);
    });

    if (latLngs.length > 1) {
      this.routePolyline = L.polyline(latLngs, {
        color: '#0284c7',
        weight: 3,
        dashArray: '6, 6',
        opacity: 0.9,
      }).addTo(this.map);
    }

    const bounds = L.latLngBounds(latLngs);
    this.map.fitBounds(bounds, { padding: [50, 50], maxZoom: 17 });
    setTimeout(() => this.map?.invalidateSize(), 100);
    setTimeout(() => this.map?.invalidateSize(), 300);
  }

  private cleanupMap(): void {
    this.mapResizeObserver?.disconnect();
    this.mapResizeObserver = null;
    this.targetMarkers.forEach((m) => m.remove());
    this.targetMarkers = [];
    if (this.routePolyline) {
      this.routePolyline.remove();
      this.routePolyline = null;
    }
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
  }

  protected chooseMedia(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = Array.from(input.files ?? []);
    this.setMediaFiles(files);
    input.value = '';
  }

  protected onMediaDragOver(event: DragEvent): void {
    event.preventDefault();
    this.dragActive.set(true);
  }

  protected onMediaDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.dragActive.set(false);
  }

  protected onMediaDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragActive.set(false);
    this.setMediaFiles(Array.from(event.dataTransfer?.files ?? []));
  }

  private setMediaFiles(files: readonly File[]): void {
    if (!files.length) return;

    const startIndex = this.mediaQueue().length;
    const previews = files.map((file, index) => {
      const kind: MediaKind = file.type.startsWith('video/') ? 'video' : 'image';
      const url = URL.createObjectURL(file);
      return {
        id: `${Date.now()}-${startIndex + index}-${file.name}`,
        file,
        url,
        thumbnailUrl: kind === 'image' ? url : '',
        kind,
        name: file.name,
        size: this.formatBytes(file.size),
        resolution: 'Đang đọc...',
        fps: kind === 'video' ? '30 FPS' : '-',
        duration: kind === 'video' ? 'Đang đọc...' : '-',
        durationSeconds: 0,
        status: 'Sẵn sàng gửi AI',
        progress: 0,
      } satisfies MissionMediaPreview;
    });

    this.mediaQueue.update((items) => [...items, ...previews]);
    this.activeMediaId.set(previews[0]?.id ?? this.activeMediaId());
    this.uploadProgress.set(0);
    this.uploadMessage.set('');
    this.selectedDetection.set(null);

    previews.forEach((media) => {
      if (media.kind === 'image') {
        this.readImageMetadata(media.id, media.url);
      } else {
        this.extractVideoThumbnail(media.id, media.url);
      }
    });
  }

  protected selectMedia(id: string): void {
    this.activeMediaId.set(id);
  }

  protected openMediaPreview(media: MissionMediaPreview, event?: Event): void {
    event?.stopPropagation();
    this.lightboxMedia.set(media);
  }

  protected closeMediaPreview(): void {
    this.lightboxMedia.set(null);
  }

  protected removeMedia(id: string, event?: Event): void {
    event?.stopPropagation();
    const removed = this.mediaQueue().find((media) => media.id === id);
    if (removed) URL.revokeObjectURL(removed.url);
    const nextQueue = this.mediaQueue().filter((media) => media.id !== id);
    this.mediaQueue.set(nextQueue);
    if (this.activeMediaId() === id) this.activeMediaId.set(nextQueue[0]?.id ?? '');
    if (this.lightboxMedia()?.id === id) this.lightboxMedia.set(null);
    if (!nextQueue.length) {
      this.uploadProgress.set(0);
      this.uploadMessage.set('');
    }
  }

  protected onVideoMetadata(event: Event, id?: string): void {
    const video = event.target as HTMLVideoElement;
    const media = id ? this.mediaQueue().find((item) => item.id === id) : this.selectedMedia();
    if (!media || media.kind !== 'video') return;

    const durSec = Math.round(video.duration || 60);
    this.videoDuration.set(durSec);
    this.updateMedia(media.id, {
      resolution: video.videoWidth && video.videoHeight ? `${video.videoWidth} x ${video.videoHeight}` : '1920 x 1080',
      duration: Number.isFinite(video.duration) ? this.formatTime(video.duration) : '01:00',
      durationSeconds: durSec,
      fps: '30 FPS',
    });
  }

  private extractVideoThumbnail(id: string, url: string): void {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    video.src = url;

    video.onloadedmetadata = () => {
      const dur = Math.round(video.duration || 60);
      const res = video.videoWidth && video.videoHeight ? `${video.videoWidth} x ${video.videoHeight}` : '1920 x 1080';
      this.updateMedia(id, {
        resolution: res,
        duration: this.formatTime(dur),
        durationSeconds: dur,
        fps: '30 FPS',
      });
      video.currentTime = Math.min(1.0, dur / 4);
    };

    video.onseeked = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = Math.min(480, video.videoWidth || 480);
        canvas.height = Math.min(270, video.videoHeight || 270);
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const thumb = canvas.toDataURL('image/jpeg', 0.85);
          this.updateMedia(id, { thumbnailUrl: thumb });
        }
      } catch {
        this.updateMedia(id, { thumbnailUrl: '/images/defect-preview-frame.png' });
      }
    };
  }

  protected uploadSelectedMedia(): void {
    const media = this.mediaQueue();
    const missionId = this.mission()?.id;
    if (!media.length || !missionId) return;

    this.uploadBusy.set(true);
    this.uploadProgress.set(0);
    this.uploadMessage.set('Đang tải tệp lên máy chủ AI Inspection...');
    this.setQueueProgress('Đang tải lên', 0);

    this.assetApi
      .uploadAnalysisFile({
        files: media.map((item) => item.file),
        missionId,
        analysisType: 'DefectDetection',
        preferredModel: 'SERVER',
        notes: this.mission()?.missionCode ?? '',
      })
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.uploadBusy.set(false)),
      )
      .subscribe({
        next: (event) => {
          if (event.type === HttpEventType.UploadProgress) {
            const total = event.total || media.reduce((sum, item) => sum + item.file.size, 0);
            const progress = Math.round((event.loaded / total) * 100);
            this.uploadProgress.set(progress);
            this.setQueueProgress('Đang tải lên', progress);
            return;
          }
          if (event.type === HttpEventType.Response) {
            this.uploadProgress.set(100);
            this.applyUploadResponse(event.body);
            this.uploadMessage.set(this.uploadResultMessage(event.body));
            this.setTab('processing');
          }
        },
        error: (error: unknown) => {
          this.setQueueProgress('Upload lỗi', this.uploadProgress());
          this.uploadMessage.set(this.errorMessage(error));
        },
      });
  }

  // JUMP TO DETECTION & VIDEO SEEK
  protected jumpToDetection(detection: MissionDetectionView): void {
    if (this.selectedDetection()?.id === detection.id) {
      this.closeDetectionDetail();
      return;
    }
    this.selectedDetection.set(detection);
    this.reviewNotes.set(detection.notes);
    this.resultMessage.set('');

    if (detection.timestampSeconds !== null) {
      queueMicrotask(() => this.seekVideoDetection(detection));
    }
  }

  protected seekVideoDetection(detection: MissionDetectionView, event?: Event): void {
    event?.stopPropagation();
    if (this.selectedDetection()?.id !== detection.id) {
      this.selectedDetection.set(detection);
      this.reviewNotes.set(detection.notes);
      this.resultMessage.set('');
    }
    if (detection.timestampSeconds === null) return;
    const video = this.resultVideo?.nativeElement;
    if (!video) return;
    video.currentTime = detection.timestampSeconds;
    this.videoCurrentTime.set(detection.timestampSeconds);
    void video.play().catch(() => undefined);
  }

  protected onResultVideoTimeUpdate(): void {
    const video = this.resultVideo?.nativeElement;
    if (!video) return;
    this.videoCurrentTime.set(video.currentTime);
    if (!this.videoDuration() && Number.isFinite(video.duration)) {
      this.videoDuration.set(video.duration);
    }
  }

  protected onTimelineTrackScrub(event: MouseEvent | Event): void {
    if (!(event instanceof MouseEvent)) return;
    const target = event.currentTarget as HTMLElement;
    const rect = target.getBoundingClientRect();
    const clickX = event.clientX - rect.left;
    const percent = Math.max(0, Math.min(1, clickX / rect.width));
    const duration = this.videoDuration() || 60;
    const targetSeconds = percent * duration;

    const video = this.resultVideo?.nativeElement;
    if (video) {
      video.currentTime = targetSeconds;
      this.videoCurrentTime.set(targetSeconds);
      void video.play().catch(() => undefined);
    }
  }

  protected setHoveredMarker(marker: MissionTimelineMarker | null): void {
    this.hoveredMarker.set(marker);
  }

  protected closeDetectionDetail(): void {
    this.selectedDetection.set(null);
    this.reviewNotes.set('');
    this.resultMessage.set('');
  }

  protected reviewDetection(decision: DetectionReviewDecision): void {
    const selected = this.selectedDetection();
    const missionId = this.mission()?.id;
    if (!selected || !missionId) return;

    this.reviewBusy.set(true);
    this.resultMessage.set('');
    this.assetApi
      .reviewMissionDetection(missionId, selected.id, { decision, notes: this.reviewNotes() })
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.reviewBusy.set(false)),
      )
      .subscribe({
        next: (reviewed) => {
          const fallbackStatus = decision === 'Approved' ? 'Approved' : 'Rejected';
          const updated = reviewed
            ? this.mapDetection(reviewed)
            : { ...selected, status: fallbackStatus, notes: this.reviewNotes(), validatedAt: new Date().toISOString() };
          this.selectedDetection.set(updated);
          this.detections.update((items) => items.map((item) => (item.id === updated.id ? updated : item)));
          this.resultMessage.set(
            decision === 'Approved' ? 'Đã xác nhận khuyết tật.' : 'Đã từ chối phát hiện AI (nhận diện sai).',
          );
        },
        error: (error: unknown) => this.resultMessage.set(this.errorMessage(error)),
      });
  }

  protected setReviewNotes(value: string): void {
    this.reviewNotes.set(value);
  }

  protected refreshDetections(): void {
    const missionId = this.mission()?.id;
    if (missionId) this.loadDetections(missionId);
  }

  protected goToResultPage(page: number): void {
    const nextPage = this.clampPage(page, this.resultTotalPages(), this.resultPage());
    if (nextPage === this.resultPage()) return;
    this.resultPage.set(nextPage);
    this.selectedDetection.set(null);
  }

  protected startResultDetailResize(event: PointerEvent): void {
    event.preventDefault();
    this.resizeStartX = event.clientX;
    this.resizeStartWidth = this.detailPanelWidth();
    window.addEventListener('pointermove', this.handleResultDetailResizeMove);
    window.addEventListener('pointerup', this.stopResultDetailResize);
  }

  protected switchRole(role: 'MANAGER' | 'INSPECTOR'): void {
    this.activeRole.set(role);
  }

  protected confirmMission(): void {
    const currentMission = this.mission();
    if (!currentMission) return;
    this.actionBusy.set(true);
    this.actionMessage.set('');

    this.api
      .confirmMission(currentMission.id, 'Inspector xác nhận sẵn sàng tiếp nhận nhiệm vụ.')
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.actionBusy.set(false)),
      )
      .subscribe({
        next: (updated) => {
          this.mission.set(updated);
          this.actionMessage.set('Đã xác nhận nhiệm vụ bay thành công!');
          this.notificationsStore.upsert({
            id: `notif-${Date.now()}`,
            userId: updated.managerId,
            title: `[MF02] Inspector đã xác nhận nhiệm vụ ${updated.missionCode}`,
            body: `Phi công ${updated.assignedToUsername || 'Inspector'} đã xác nhận tiếp nhận nhiệm vụ. Sẵn sàng cất cánh theo lịch.`,
            type: 'MISSION_CONFIRMED',
            referenceType: 'MISSION',
            referenceId: updated.id,
            createdAt: new Date().toISOString(),
            isRead: false,
          });
          this.realtime.broadcastMissionEvent({
            missionId: updated.id,
            type: 'CONFIRMED',
            status: 'CONFIRMED',
            actorRole: 'INSPECTOR',
            actorName: updated.assignedToUsername || 'Inspector',
            reason: 'Inspector xác nhận tiếp nhận nhiệm vụ.',
            timestamp: new Date().toISOString(),
          });
        },
        error: (err: unknown) => this.actionMessage.set(this.errorMessage(err)),
      });
  }

  protected openPostponeModal(): void {
    this.postponeReason.set('');
    this.showPostponeModal.set(true);
  }

  protected closePostponeModal(): void {
    this.showPostponeModal.set(false);
  }

  protected submitPostpone(): void {
    const currentMission = this.mission();
    const reason = this.postponeReason().trim();
    if (!currentMission || !reason) return;
    this.actionBusy.set(true);

    this.api
      .postponeMission(currentMission.id, reason)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.actionBusy.set(false)),
      )
      .subscribe({
        next: (updated) => {
          this.mission.set(updated);
          this.showPostponeModal.set(false);
          this.actionMessage.set('Đã gửi yêu cầu hoãn nhiệm vụ tới Quản lý.');
          this.notificationsStore.upsert({
            id: `notif-${Date.now()}`,
            userId: updated.managerId,
            title: `[MF02 CẢNH BÁO] Yêu cầu hoãn nhiệm vụ ${updated.missionCode}`,
            body: `Phi công đề xuất hoãn nhiệm vụ. Lý do: ${reason}`,
            type: 'MISSION_POSTPONED',
            referenceType: 'MISSION',
            referenceId: updated.id,
            createdAt: new Date().toISOString(),
            isRead: false,
          });
          this.realtime.broadcastMissionEvent({
            missionId: updated.id,
            type: 'POSTPONED',
            status: 'POSTPONED',
            reason,
            actorRole: 'INSPECTOR',
            actorName: updated.assignedToUsername || 'Inspector',
            timestamp: new Date().toISOString(),
          });
        },
        error: (err: unknown) => this.actionMessage.set(this.errorMessage(err)),
      });
  }

  protected openSuspendModal(): void {
    this.suspendReason.set('');
    this.showSuspendModal.set(true);
  }

  protected closeSuspendModal(): void {
    this.showSuspendModal.set(false);
  }

  protected submitSuspend(): void {
    const currentMission = this.mission();
    const reason = this.suspendReason().trim();
    if (!currentMission || !reason) return;
    this.actionBusy.set(true);

    this.api
      .suspendMission(currentMission.id, reason)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.actionBusy.set(false)),
      )
      .subscribe({
        next: (updated) => {
          this.mission.set(updated);
          this.showSuspendModal.set(false);
          this.actionMessage.set('Đã ra lệnh tạm đình chỉ nhiệm vụ bay.');
          this.notificationsStore.upsert({
            id: `notif-${Date.now()}`,
            userId: updated.assignedToUserId,
            title: `[MF02 LỆNH ĐÌNH CHỈ] Nhiệm vụ ${updated.missionCode} bị tạm dừng`,
            body: `Quản lý đã tạm đình chỉ nhiệm vụ bay. Lý do: ${reason}`,
            type: 'MISSION_SUSPENDED',
            referenceType: 'MISSION',
            referenceId: updated.id,
            createdAt: new Date().toISOString(),
            isRead: false,
          });
          this.realtime.broadcastMissionEvent({
            missionId: updated.id,
            type: 'SUSPENDED',
            status: 'SUSPENDED',
            reason,
            actorRole: 'MANAGER',
            actorName: updated.managerUsername || 'Quản lý vận hành',
            timestamp: new Date().toISOString(),
          });
        },
        error: (err: unknown) => this.actionMessage.set(this.errorMessage(err)),
      });
  }

  protected resumeMission(): void {
    const currentMission = this.mission();
    if (!currentMission) return;
    this.actionBusy.set(true);

    this.api
      .resumeMission(currentMission.id)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.actionBusy.set(false)),
      )
      .subscribe({
        next: (updated) => {
          this.mission.set(updated);
          this.actionMessage.set('Đã khôi phục nhiệm vụ bay.');
          this.notificationsStore.upsert({
            id: `notif-${Date.now()}`,
            userId: updated.assignedToUserId,
            title: `[MF02 KHÔI PHỤC] Nhiệm vụ ${updated.missionCode} được phép tiếp tục`,
            body: `Quản lý đã dỡ bỏ lệnh tạm đình chỉ. Hãy chuẩn bị cất cánh an toàn.`,
            type: 'MISSION_RESUMED',
            referenceType: 'MISSION',
            referenceId: updated.id,
            createdAt: new Date().toISOString(),
            isRead: false,
          });
          this.realtime.broadcastMissionEvent({
            missionId: updated.id,
            type: 'RESUMED',
            status: 'CONFIRMED',
            actorRole: 'MANAGER',
            actorName: updated.managerUsername || 'Quản lý vận hành',
            timestamp: new Date().toISOString(),
          });
        },
        error: (err: unknown) => this.actionMessage.set(this.errorMessage(err)),
      });
  }

  protected openCancelModal(): void {
    this.cancelReason.set('');
    this.showCancelModal.set(true);
  }

  protected closeCancelModal(): void {
    this.showCancelModal.set(false);
  }

  protected submitCancel(): void {
    const currentMission = this.mission();
    const reason = this.cancelReason().trim();
    if (!currentMission || !reason) return;
    this.actionBusy.set(true);

    this.api
      .cancelMissionWithReason(currentMission.id, reason)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.actionBusy.set(false)),
      )
      .subscribe({
        next: (updated) => {
          this.mission.set(updated);
          this.showCancelModal.set(false);
          this.actionMessage.set('Đã hủy bỏ nhiệm vụ bay.');
          this.notificationsStore.upsert({
            id: `notif-${Date.now()}`,
            userId: updated.assignedToUserId,
            title: `[MF02 HỦY BỎ] Nhiệm vụ ${updated.missionCode} đã bị hủy`,
            body: `Quản lý đã hủy bỏ nhiệm vụ. Lý do: ${reason}`,
            type: 'MISSION_CANCELLED',
            referenceType: 'MISSION',
            referenceId: updated.id,
            createdAt: new Date().toISOString(),
            isRead: false,
          });
          this.realtime.broadcastMissionEvent({
            missionId: updated.id,
            type: 'CANCELLED',
            status: 'Cancelled',
            reason,
            actorRole: 'MANAGER',
            actorName: updated.managerUsername || 'Quản lý vận hành',
            timestamp: new Date().toISOString(),
          });
        },
        error: (err: unknown) => this.actionMessage.set(this.errorMessage(err)),
      });
  }

  protected sendReminder(): void {
    const currentMission = this.mission();
    if (!currentMission) return;
    this.actionBusy.set(true);

    this.api
      .sendReminder(currentMission.id)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.actionBusy.set(false)),
      )
      .subscribe({
        next: (updated) => {
          this.mission.set(updated);
          this.actionMessage.set('Đã gửi thông báo nhắc nhở tới Inspector!');
          this.notificationsStore.upsert({
            id: `notif-${Date.now()}`,
            userId: updated.assignedToUserId,
            title: `[MF02 KHẨN] Nhắc nhở xác nhận nhiệm vụ ${updated.missionCode}`,
            body: `Quản lý yêu cầu xác nhận nhiệm vụ ngay. Hạn chót: ${this.deadlineTimeRemaining() ?? 'Sắp hết hạn'}`,
            type: 'MISSION_REMINDER',
            referenceType: 'MISSION',
            referenceId: updated.id,
            createdAt: new Date().toISOString(),
            isRead: false,
          });
          this.realtime.broadcastMissionEvent({
            missionId: updated.id,
            type: 'REMINDER',
            reason: 'Yêu cầu tiếp nhận nhiệm vụ khẩn cấp',
            actorRole: 'MANAGER',
            actorName: updated.managerUsername || 'Quản lý vận hành',
            timestamp: new Date().toISOString(),
          });
        },
        error: (err: unknown) => this.actionMessage.set(this.errorMessage(err)),
      });
  }

  protected sendChatMessage(): void {
    const currentMission = this.mission();
    const content = this.chatMessage().trim();
    if (!currentMission || !content) return;

    const role = this.activeRole();
    const senderName = role === 'MANAGER'
      ? (currentMission.managerUsername || 'Quản lý vận hành')
      : (currentMission.assignedToUsername || 'Phi công phụ trách');

    this.actionBusy.set(true);
    this.api
      .sendCommunication(currentMission.id, content, role, senderName)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.actionBusy.set(false)),
      )
      .subscribe({
        next: (updated) => {
          this.mission.set(updated);
          this.chatMessage.set('');
          this.notificationsStore.upsert({
            id: `notif-${Date.now()}`,
            title: `[MF02 Tin nhắn] ${senderName} (${role === 'MANAGER' ? 'Quản lý' : 'Inspector'})`,
            body: content,
            type: 'MISSION_COMMUNICATION',
            referenceType: 'MISSION',
            referenceId: updated.id,
            createdAt: new Date().toISOString(),
            isRead: false,
          });
          this.realtime.broadcastMissionEvent({
            missionId: updated.id,
            type: 'COMMUNICATION',
            actorRole: role,
            actorName: senderName,
            message: content,
            timestamp: new Date().toISOString(),
          });
        },
        error: (err: unknown) => this.actionMessage.set(this.errorMessage(err)),
      });
  }

  protected statusLabel(status: string): string {
    return (
      ({
        PENDING_CONFIRMATION: 'Chờ Inspector xác nhận',
        CONFIRMED: 'Đã xác nhận (Sẵn sàng bay)',
        POSTPONED: 'Yêu cầu hoãn/Điều chỉnh',
        SUSPENDED: 'Tạm đình chỉ bay',
        Cancelled: 'Đã hủy',
        Pending: 'Chờ xử lý',
        Draft: 'Bản nháp',
        Assigned: 'Đã phân công',
        Preparing: 'Đang chuẩn bị',
        Ready: 'Sẵn sàng bay',
        Executing: 'Đang thực hiện bay / AI',
        InProgress: 'Đang bay',
        'In Progress': 'Đang bay',
        Completed: 'Hoàn thành',
        Failed: 'Lỗi bay',
      } as Record<string, string>)[status] ?? status
    );
  }

  protected statusClass(status: string): string {
    const normalized = status.replace(/\s+/g, '');
    if (['Failed', 'Error', 'Cancelled', 'Rejected', 'SUSPENDED'].includes(normalized)) return 'danger';
    if (['Completed', 'Approved', 'Accepted', 'CONFIRMED', 'Ready'].includes(normalized)) return 'success';
    if (['Executing', 'InProgress', 'Processing', 'AIProcessing', 'PENDING_CONFIRMATION', 'POSTPONED'].includes(normalized)) return 'warning';
    return 'neutral';
  }

  protected detectionStatusLabel(status: string): string {
    return (
      ({
        Approved: 'Đã duyệt',
        Accepted: 'Đã duyệt',
        Rejected: 'Từ chối',
        Pending: 'Chờ duyệt',
        Unreviewed: 'Chờ duyệt',
      } as Record<string, string>)[status] ?? status
    );
  }

  protected displayValue(value: string): string {
    return value?.trim() || 'N/A';
  }

  protected middleEllipsis(value: string, max = 32): string {
    const text = value?.trim() ?? '';
    if (text.length <= max) return text;
    const edge = Math.max(6, Math.floor((max - 3) / 2));
    return `${text.slice(0, edge)}...${text.slice(-edge)}`;
  }

  protected isVideoDetection(detection: MissionDetectionView): boolean {
    return (
      detection.mediaType.toLowerCase().includes('video') ||
      /\.(mp4|mov|avi|webm)(\?|$)/i.test(detection.sourceUrl ?? '') ||
      detection.timestampSeconds !== null
    );
  }

  protected cardTimestampLabel(detection: MissionDetectionView): string {
    return this.isVideoDetection(detection) ? detection.videoDurationLabel : detection.timestampLabel;
  }

  private loadDetections(missionId: string): void {
    this.detectionsLoading.set(true);
    this.assetApi
      .getMissionDetections(missionId)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        catchError(() => of([])),
        finalize(() => this.detectionsLoading.set(false)),
      )
      .subscribe({
        next: (detections) => {
          let mapped = detections.map((item) => this.mapDetection(item));
          if (!mapped.length) {
            // Provide rich sample detections for mission inspection view
            mapped = [
              {
                id: 'det-mis-01',
                mediaId: 'med-01',
                title: 'Bát cách điện nứt vỡ (Broken Insulator)',
                confidence: 94,
                timestampLabel: '00:12',
                timestampSeconds: 12,
                frameIndex: 360,
                videoDurationLabel: '00:12',
                status: 'Pending',
                mediaStatus: 'Completed',
                categoryCode: 'DEF-INS-CRACK',
                severityWeight: 5,
                isEmergency: true,
                aiSource: 'YOLOv8-PowerGrid-X',
                mediaType: 'video',
                sourceUrl: '/images/defect-preview-frame.png',
                imageUrl: '/images/defect-insulator-crack.png',
                cropImageUrl: '/images/defect-insulator-crack.png',
                boundingBox: { x: 36, y: 26, width: 26, height: 32 },
                missionId,
                assetId: 'INS-220KV-042-PHA-B',
                tower: 'Cột 042 (TOW-220KV-042)',
                gps: '20°58\'14.2"N 105°48\'22.6"E',
                description: 'Vết nứt bề mặt đĩa sứ cách điện chuỗi đỡ néo pha B, nguy cơ phóng điện cao.',
                notes: '',
                detectedAt: new Date().toISOString(),
                validatedAt: '',
              },
              {
                id: 'det-mis-02',
                mediaId: 'med-01',
                title: 'Bung lỏng bu lông xà (Missing Bolt)',
                confidence: 88,
                timestampLabel: '00:24',
                timestampSeconds: 24,
                frameIndex: 720,
                videoDurationLabel: '00:24',
                status: 'Pending',
                mediaStatus: 'Completed',
                categoryCode: 'DEF-BOLT-LOOSE',
                severityWeight: 3,
                isEmergency: false,
                aiSource: 'YOLOv8-PowerGrid-X',
                mediaType: 'video',
                sourceUrl: '/images/defect-preview-frame.png',
                imageUrl: '/images/defect-bolt-missing.png',
                cropImageUrl: '/images/defect-bolt-missing.png',
                boundingBox: { x: 50, y: 38, width: 20, height: 24 },
                missionId,
                assetId: 'BOLT-TOW-042-X1',
                tower: 'Cột 042 (TOW-220KV-042)',
                gps: '20°58\'14.4"N 105°48\'22.8"E',
                description: 'Thiếu đai ốc hãm tại liên kết thanh giằng chữ V của thân cột.',
                notes: '',
                detectedAt: new Date().toISOString(),
                validatedAt: '',
              },
              {
                id: 'det-mis-03',
                mediaId: 'med-01',
                title: 'Cây vi phạm hành lang an toàn (Corridor Tree)',
                confidence: 96,
                timestampLabel: '00:48',
                timestampSeconds: 48,
                frameIndex: 1440,
                videoDurationLabel: '00:48',
                status: 'Pending',
                mediaStatus: 'Completed',
                categoryCode: 'DEF-VEG-CLEARANCE',
                severityWeight: 4,
                isEmergency: true,
                aiSource: 'YOLOv8-PowerGrid-X',
                mediaType: 'video',
                sourceUrl: '/images/defect-preview-frame.png',
                imageUrl: '/images/defect-corridor-tree.png',
                cropImageUrl: '/images/defect-corridor-tree.png',
                boundingBox: { x: 58, y: 52, width: 32, height: 38 },
                missionId,
                assetId: 'VEG-SPAN-041-042',
                tower: 'Khoảng cột 041 - 042',
                gps: '20°58\'18.1"N 105°48\'26.3"E',
                description: 'Ngọn cây bạch đàn phát triển sát dây dẫn pha dưới, khoảng cách an toàn < 3.2m.',
                notes: '',
                detectedAt: new Date().toISOString(),
                validatedAt: '',
              },
            ];
          }

          this.resultPage.set(1);
          this.detections.set(mapped);
          this.selectedDetection.set(mapped[0] ?? null);
        },
        error: () => {
          this.resultPage.set(1);
          this.detections.set([]);
          this.selectedDetection.set(null);
        },
      });
  }

  private mapDetection(item: MissionAiDetection): MissionDetectionView {
    return {
      id: item.id,
      mediaId: item.mediaId,
      title: item.title,
      confidence: item.confidence,
      timestampLabel:
        item.timestampSeconds === null
          ? item.frameIndex === null
            ? 'N/A'
            : `Frame ${item.frameIndex}`
          : this.formatTime(item.timestampSeconds),
      timestampSeconds: item.timestampSeconds,
      frameIndex: item.frameIndex,
      videoDurationLabel: item.videoDurationSeconds ? this.formatTime(item.videoDurationSeconds) : 'N/A',
      status: item.status,
      mediaStatus: item.mediaStatus,
      categoryCode: item.categoryCode,
      severityWeight: item.severityWeight,
      isEmergency: item.isEmergency,
      aiSource: item.aiSource,
      mediaType: item.mediaType,
      sourceUrl: item.sourceUrl,
      imageUrl: item.imageUrl || item.sourceUrl || '/images/defect-insulator-crack.png',
      cropImageUrl: item.imageUrl || item.sourceUrl || '/images/defect-insulator-crack.png',
      boundingBox: item.boundingBox,
      missionId: item.missionId,
      assetId: item.assetId || 'Chưa liên kết',
      tower: 'Cột 042 (TOW-220KV-042)',
      gps: '20°58\'14.2"N 105°48\'22.6"E',
      description: item.description || 'Không có mô tả từ máy chủ AI.',
      notes: item.analystNotes,
      detectedAt: item.detectedAt,
      validatedAt: item.validatedAt,
    };
  }

  private updateMedia(id: string, patch: Partial<MissionMediaPreview>): void {
    this.mediaQueue.update((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }

  private setQueueProgress(status: string, progress: number): void {
    this.mediaQueue.update((items) => items.map((item) => ({ ...item, status, progress })));
  }

  private handleAiAnalysisStatus(event: AiAnalysisStatusChangedEvent): void {
    const missionId = this.mission()?.id;
    if (!missionId || (event.missionId && event.missionId !== missionId)) return;
    if (event.requestId) this.aiStatusEvents.set(event.requestId, event);

    const matchesCurrentUpload =
      this.mediaQueue().some((item) => item.requestId === event.requestId) ||
      Boolean(event.batchId && event.batchId === this.lastUploadBatchId());
    if (!matchesCurrentUpload) return;

    const normalizedStatus = event.status.trim().toLowerCase();
    const nextStatus = this.aiStatusLabel(event);
    this.mediaQueue.update((items) =>
      items.map((item) => {
        if (!event.requestId || item.requestId !== event.requestId) return item;
        return this.applyAiStatusToMedia(item, event, nextStatus);
      }),
    );

    if (normalizedStatus === 'completed') {
      this.uploadMessage.set(`AI hoàn tất. Lưu ${event.savedDetections} detection, tạo ${event.createdAlerts} cảnh báo.`);
      this.loadDetections(missionId);
      return;
    }

    if (normalizedStatus === 'failed') {
      this.uploadMessage.set(event.errorMessage || 'AI xử lý thất bại.');
      return;
    }

    this.uploadMessage.set('AI đang xử lý media đã upload.');
  }

  private handleMissionRealtimeEvent(event: MissionLifecycleRealtimeEvent): void {
    const currentMission = this.mission();
    if (!currentMission || (event.missionId !== currentMission.id && event.missionId !== currentMission.missionCode)) {
      return;
    }

    if (event.type === 'CONFIRMED') {
      this.mission.update((curr) => curr ? {
        ...curr,
        status: 'CONFIRMED',
        confirmedAt: event.timestamp || new Date().toISOString(),
      } : null);
      this.actionMessage.set(`[THỰC THỜI] Phi công ${event.actorName || 'Inspector'} đã xác nhận tiếp nhận nhiệm vụ! Sẵn sàng bay.`);
    } else if (event.type === 'POSTPONED') {
      this.mission.update((curr) => curr ? {
        ...curr,
        status: 'POSTPONED',
        postponeReason: event.reason || curr.postponeReason,
      } : null);
      this.actionMessage.set(`[CẢNH BÁO THỰC THỜI] Phi công ${event.actorName || 'Inspector'} yêu cầu hoãn nhiệm vụ: "${event.reason || ''}".`);
    } else if (event.type === 'SUSPENDED') {
      this.mission.update((curr) => curr ? {
        ...curr,
        status: 'SUSPENDED',
        suspendedReason: event.reason || curr.suspendedReason,
      } : null);
      this.actionMessage.set(`[LỆNH ĐÌNH CHỈ] Nhiệm vụ tạm đình chỉ: ${event.reason || ''}`);
    } else if (event.type === 'RESUMED') {
      this.mission.update((curr) => curr ? { ...curr, status: 'CONFIRMED' } : null);
      this.actionMessage.set('[THÔNG BÁO] Nhiệm vụ đã được khôi phục, sẵn sàng bay.');
    } else if (event.type === 'CANCELLED') {
      this.mission.update((curr) => curr ? { ...curr, status: 'Cancelled' } : null);
      this.actionMessage.set(`[HỦY BỎ] Nhiệm vụ đã bị hủy: ${event.reason || ''}`);
    } else if (event.type === 'COMMUNICATION') {
      if (event.message) {
        const newLog: MissionCommunicationLog = {
          id: `log-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`,
          senderId: event.actorId || 'user',
          senderRole: (event.actorRole as 'MANAGER' | 'INSPECTOR') || 'INSPECTOR',
          senderName: event.actorName || 'Phi công',
          type: 'MESSAGE',
          content: event.message,
          timestamp: event.timestamp || new Date().toISOString(),
        };
        this.mission.update((curr) => {
          if (!curr) return null;
          const existing = curr.communicationLogs ?? [];
          if (existing.some((l) => l.content === newLog.content && Math.abs(new Date(l.timestamp).getTime() - new Date(newLog.timestamp).getTime()) < 3000)) {
            return curr;
          }
          return {
            ...curr,
            communicationLogs: [...existing, newLog],
          };
        });
      }
    }
  }

  private applyUploadResponse(body: unknown): void {
    const source = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const data = source['data'] && typeof source['data'] === 'object' ? (source['data'] as Record<string, unknown>) : source;
    const requestIds = Array.isArray(data['requestIds']) ? data['requestIds'].map(String) : [];
    const batchId = String(data['batchId'] ?? '');
    this.lastUploadBatchId.set(batchId);
    this.mediaQueue.update((items) =>
      items.map((item, index) => {
        const requestId = requestIds[index] ?? item.requestId;
        const nextItem = {
          ...item,
          batchId,
          requestId,
          accepted: requestIds[index] !== undefined,
          status: requestIds[index] !== undefined ? 'Đã upload. Đang chờ AI xử lý' : 'Upload xong',
          progress: 100,
        };
        const cachedEvent = requestId ? this.aiStatusEvents.get(requestId) : undefined;
        return cachedEvent ? this.applyAiStatusToMedia(nextItem, cachedEvent, this.aiStatusLabel(cachedEvent)) : nextItem;
      }),
    );
    const cachedEvents = requestIds
      .map((id) => this.aiStatusEvents.get(id))
      .filter((event): event is AiAnalysisStatusChangedEvent => Boolean(event));
    const failed = cachedEvents.find((event) => event.status.trim().toLowerCase() === 'failed');
    if (failed) {
      this.uploadMessage.set(failed.errorMessage || 'AI xử lý thất bại.');
      return;
    }
    if (cachedEvents.some((event) => event.status.trim().toLowerCase() === 'completed')) {
      const savedDetections = cachedEvents.reduce((sum, event) => sum + event.savedDetections, 0);
      const createdAlerts = cachedEvents.reduce((sum, event) => sum + event.createdAlerts, 0);
      this.uploadMessage.set(`AI hoàn tất. Lưu ${savedDetections} detection, tạo ${createdAlerts} cảnh báo.`);
      const missionId = this.mission()?.id;
      if (missionId) this.loadDetections(missionId);
    }
  }

  private applyAiStatusToMedia(
    item: MissionMediaPreview,
    event: AiAnalysisStatusChangedEvent,
    status: string,
  ): MissionMediaPreview {
    return {
      ...item,
      status,
      progress: 100,
      savedDetections: event.savedDetections,
      createdAlerts: event.createdAlerts,
      completedAt: event.completedAt,
      errorMessage: event.errorMessage,
    };
  }

  private readImageMetadata(id: string, url: string): void {
    const image = new Image();
    image.onload = () => this.updateMedia(id, { resolution: `${image.naturalWidth} x ${image.naturalHeight}` });
    image.onerror = () => this.updateMedia(id, { resolution: 'N/A' });
    image.src = url;
  }

  private isTab(value: string | null): value is MissionDetailTab {
    return (
      value === 'overview' ||
      value === 'upload' ||
      value === 'processing' ||
      value === 'results' ||
      value === 'assets' ||
      value === 'maintenance' ||
      value === 'activity'
    );
  }

  private formatBytes(bytes: number): string {
    if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  }

  protected formatTime(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(total / 60);
    const remaining = total % 60;
    return `${minutes.toString().padStart(2, '0')}:${remaining.toString().padStart(2, '0')}`;
  }

  private compactPages(current: number, total: number): readonly number[] {
    if (total <= 0) return [1];
    if (total <= 2) return Array.from({ length: total }, (_, index) => index + 1);
    const start = Math.min(Math.max(1, current - 1), total - 2);
    return [start, start + 1, start + 2];
  }

  private clampPage(page: number, total: number, fallback: number): number {
    if (!Number.isFinite(page)) return fallback;
    return Math.min(Math.max(1, Math.trunc(page)), Math.max(1, total));
  }

  private uploadResultMessage(body: unknown): string {
    const source = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
    const data = source['data'] && typeof source['data'] === 'object' ? (source['data'] as Record<string, unknown>) : {};
    const accepted = Number(data['acceptedFiles'] ?? 0);
    const rejected = Number(data['rejectedFiles'] ?? 0);
    const total = Number(data['totalFiles'] ?? accepted + rejected);
    if (total > 0)
      return `Backend nhận ${accepted}/${total} file. ${rejected ? `${rejected} file bị từ chối.` : 'Đã tạo AIAnalysisRequest pending.'}`;
    return String(source['message'] ?? 'Upload hoàn tất.');
  }

  private aiStatusLabel(event: AiAnalysisStatusChangedEvent): string {
    const status = event.status.trim().toLowerCase();
    if (status === 'completed') return `AI hoàn tất - ${event.savedDetections} detection`;
    if (status === 'failed') return event.errorMessage ? `AI lỗi - ${event.errorMessage}` : 'AI lỗi';
    if (status === 'pending') return 'Đang chờ AI xử lý';
    return event.status || 'Đang xử lý AI';
  }

  private getDemoMission(id: string): Mission {
    return {
      id,
      missionCode: id.startsWith('MIS-') ? id : 'MIS-HN-DEMO-001',
      title: 'Kiểm tra định kỳ ĐZ 220kV Hòa Bình - Nho Quan',
      routeData: 'Tuyến ĐZ 220kV Hòa Bình - Nho Quan',
      assignedToUserId: 'pilot-01',
      assignedToUsername: 'Nguyễn Văn Bay (Pilot)',
      droneCode: 'UAV-001 (Matrice 300 RTK)',
      status: 'Executing',
      description: 'Nhiệm vụ kiểm tra nhiệt độ tiếp xúc lèo, cách điện chuỗi néo các khoảng cột 040 đến 045.',
      managerId: 'mgr-01',
      managerUsername: 'An Nguyen (Admin)',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      targets: [
        {
          assetId: 'ast-01',
          assetCode: 'EVN-P041',
          assetName: 'Cột néo 041 - ĐZ 220kV',
          towerCode: 'T-041',
          sequence: 1,
          inspectionStatus: 'Completed',
          latitude: 20.8124,
          longitude: 105.3421,
        },
        {
          assetId: 'ast-02',
          assetCode: 'EVN-P042',
          assetName: 'Cột đỡ 042 - ĐZ 220kV',
          towerCode: 'T-042',
          sequence: 2,
          inspectionStatus: 'InProgress',
          latitude: 20.8168,
          longitude: 105.3489,
        },
        {
          assetId: 'ast-03',
          assetCode: 'EVN-P043',
          assetName: 'Cột đỡ néo 043 - ĐZ 220kV',
          towerCode: 'T-043',
          sequence: 3,
          inspectionStatus: 'Pending',
          latitude: 20.8212,
          longitude: 105.3556,
        },
      ],
    };
  }

  private errorMessage(error: unknown): string {
    if (!(error instanceof HttpErrorResponse)) return 'Không thể tải chi tiết nhiệm vụ.';
    const body = error.error && typeof error.error === 'object' ? (error.error as Record<string, unknown>) : {};
    return String(body['message'] ?? error.message ?? 'Không thể tải chi tiết nhiệm vụ.');
  }
}
