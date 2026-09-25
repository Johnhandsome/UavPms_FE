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
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, RouterLink } from '@angular/router';
import * as L from 'leaflet';
import { catchError, finalize, of } from 'rxjs';
import { NzIconModule } from 'ng-zorro-antd/icon';
import {
  Mission,
  MissionAssignment,
  MissionAssignmentsOverview,
  MissionBackendActivity,
  MissionBackendDetection,
  MissionBackendMaintenanceTask,
  MissionCommunicationLog,
  MissionOperationalRole,
  MissionTarget,
} from '../../../../models/missions.models';
import { UserRecord } from '../../../../models/users.models';
import { AssetManagementApi, DetectionReviewDecision, MissionAiDetection } from '../../../assets/data-access/asset-management-api';
import {
  AiAnalysisStatusChangedEvent,
  MissionLifecycleRealtimeEvent,
  NotificationsRealtime,
} from '../../../notifications/data-access/notifications-realtime';
import { MissionsApi } from '../../data-access/missions-api';
import { UsersApi } from '../../../users/data-access/users-api';
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
  imports: [DatePipe, RouterLink, NzIconModule, FormsModule],
  templateUrl: './mission-detail.html',
  styleUrl: './mission-detail.scss',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MissionDetail {
  private readonly api = inject(MissionsApi);
  private readonly usersApi = inject(UsersApi);
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
  protected readonly selectedAssignmentToPostpone = signal<MissionAssignment | null>(null);
  protected readonly postponeReason = signal('');
  protected readonly showSuspendModal = signal(false);
  protected readonly suspendReason = signal('');
  protected readonly showCancelModal = signal(false);
  protected readonly cancelReason = signal('');
  protected readonly chatMessage = signal('');
  protected readonly currentTime = signal(Date.now());

  // Multi-Role Team & Reassign State (MF02)
  protected readonly availableUsers = signal<readonly UserRecord[]>([]);
  protected readonly showReassignModal = signal<boolean>(false);
  protected readonly selectedAssignmentToReassign = signal<MissionAssignment | null>(null);
  protected readonly reassignNewUserId = signal<string>('');
  protected readonly reassignReason = signal<string>('');

  protected readonly multiRoleTeam = computed<readonly MissionAssignment[]>(() => {
    return this.mission()?.team ?? [];
  });

  protected readonly allRolesConfirmed = computed<boolean>(() => {
    return this.mission()?.allConfirmed ?? false;
  });

  protected readonly confirmationProgressPct = computed<number>(() => {
    return Math.round(Number(this.mission()?.confirmationProgress ?? 0) * 100);
  });

  protected readonly postponedMember = computed<MissionAssignment | null>(() => {
    return this.multiRoleTeam().find((m) => m.responseStatus === 'POSTPONED') ?? null;
  });

  protected readonly reassignCandidatePool = computed<readonly UserRecord[]>(() => {
    const assignment = this.selectedAssignmentToReassign();
    if (!assignment) return this.availableUsers();
    const targetRole = (assignment.assignmentRole || '').toLowerCase();
    return this.availableUsers().filter((u) => {
      const userRole = (u.role || '').toLowerCase();
      if (targetRole.includes('inspector') || targetRole.includes('pilot')) {
        return userRole.includes('inspector') || userRole.includes('pilot') || userRole.includes('phi công');
      }
      if (targetRole.includes('analyst')) {
        return userRole.includes('analyst') || userRole.includes('phân tích') || userRole.includes('dữ liệu');
      }
      if (targetRole.includes('tech')) {
        return userRole.includes('tech') || userRole.includes('kỹ thuật') || userRole.includes('bảo trì');
      }
      return true;
    });
  });

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

  protected readonly isLinearUploadBlocked = computed(() => {
    const m = this.mission();
    if (!m) return true;
    const s = (m.status || '').toLowerCase();
    return (
      s === 'draft' ||
      s === 'pendingacceptance' ||
      s === 'pending_confirmation' ||
      s === 'pending' ||
      s === 'postponed' ||
      s === 'suspended' ||
      s === 'cancelled'
    );
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

  // Mission Maintenance Recommendations (Derived from Approved Detections or Mission Maintenance API)
  protected readonly maintenanceTasks = signal<readonly MissionMaintenanceTask[]>([]);
  protected readonly criticalAssetCount = computed(
    () => this.missionAssets().filter((a) => a.healthScore > 0 && a.healthScore < 40).length,
  );
  protected readonly stableAssetCount = computed(
    () => this.missionAssets().filter((a) => a.healthScore >= 80).length,
  );

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

    this.usersApi
      .getAll()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (users) => this.availableUsers.set(users),
        error: () => {},
      });

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
            healthScore: 98,
            riskLevel: 'Low Risk',
            defectCount: 0,
            status: 'Operational',
            lastInspected: '27/08/2026 14:20',
          })));
          this.loadAssignmentsOverview(mission.id);
          this.loadDetections(mission.id);
          this.loadMaintenanceTasks(mission.id);
          this.loadActivities(mission.id);
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
    const missionId = this.mission()?.id;
    if (!missionId) return;

    if (tab === 'results' || tab === 'processing') {
      this.loadDetections(missionId);
    } else if (tab === 'maintenance') {
      this.loadMaintenanceTasks(missionId);
    } else if (tab === 'activity') {
      this.loadActivities(missionId);
    } else if (tab === 'overview') {
      this.loadAssignmentsOverview(missionId);
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
        scrollWheelZoom: false,
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
    if (this.isLinearUploadBlocked()) {
      this.uploadMessage.set(
        '⛔ VÒNG ĐỜI TUYẾN TÍNH: Nhiệm vụ đang ở trạng thái dự thảo hoặc chờ các vai trò xác nhận tiếp nhận. Không thể nạp ảnh/video khi chưa bay.',
      );
      return;
    }
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
          const msg = this.errorMessage(error);
          if (
            msg.includes('INVALID_MISSION_STATUS_FOR_UPLOAD') ||
            msg.includes('dự thảo') ||
            msg.includes('chờ các vai trò xác nhận')
          ) {
            this.uploadMessage.set(
              '⛔ CHẶN TẢI MEDIA (Quy chuẩn Tuyến tính): Nhiệm vụ đang ở trạng thái dự thảo hoặc chờ xác nhận tiếp nhận. Vui lòng hoàn tất tiếp nhận 3 vai trò và thực hiện bay trước khi tải ảnh/video.',
            );
          } else {
            this.uploadMessage.set(msg);
          }
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
    const backendStatus: 'Approved' | 'Rejected' = decision === 'Approved' ? 'Approved' : 'Rejected';

    this.api
      .reviewDetection(missionId, selected.id, {
        status: backendStatus,
        reviewNotes: this.reviewNotes(),
      })
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        catchError(() =>
          this.assetApi.reviewMissionDetection(missionId, selected.id, { decision, notes: this.reviewNotes() }),
        ),
        finalize(() => this.reviewBusy.set(false)),
      )
      .subscribe({
        next: () => {
          const updated: MissionDetectionView = {
            ...selected,
            status: backendStatus,
            notes: this.reviewNotes(),
            validatedAt: new Date().toISOString(),
          };
          this.selectedDetection.set(updated);
          this.detections.update((items) => items.map((item) => (item.id === updated.id ? updated : item)));
          this.resultMessage.set(
            decision === 'Approved'
              ? 'Đã duyệt khuyết tật. Hệ thống tự động khấu trừ điểm sức khỏe tài sản và lập phiếu bảo trì!'
              : 'Đã từ chối phát hiện AI (nhận diện sai).',
          );
          // Auto reload maintenance tasks generated by backend
          this.loadMaintenanceTasks(missionId);
          this.syncAssetsWithDetections(this.mission()?.targets ?? [], this.detections());
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

  protected acceptMemberAssignment(assignment: MissionAssignment): void {
    const currentMission = this.mission();
    if (!currentMission) return;
    this.actionBusy.set(true);
    this.actionMessage.set('');

    const userName = assignment.userFullName || assignment.userName || 'Thành viên';
    this.api
      .acceptAssignment(
        currentMission.id,
        assignment.id,
        `${assignment.assignmentRole} đã xác nhận sẵn sàng tiếp nhận nhiệm vụ.`,
        assignment.assignmentRole,
        userName,
      )
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.actionBusy.set(false)),
      )
      .subscribe({
        next: (updated) => {
          this.mission.set(updated);
          this.actionMessage.set(`[${assignment.assignmentRole}] ${userName} đã xác nhận tiếp nhận thành công!`);
          this.realtime.broadcastMissionEvent({
            missionId: updated.id,
            type: 'CONFIRMED',
            status: updated.status,
            assignmentId: assignment.id,
            actorRole: assignment.assignmentRole,
            actorName: userName,
            allConfirmed: updated.allConfirmed,
            confirmedCount: updated.confirmedCount,
            totalRequiredCount: updated.totalRequiredCount,
            reason: `${assignment.assignmentRole} xác nhận tiếp nhận nhiệm vụ.`,
            timestamp: new Date().toISOString(),
          });
        },
        error: (err: unknown) => this.actionMessage.set(this.errorMessage(err)),
      });
  }

  protected openPostponeModal(assignment?: MissionAssignment): void {
    this.selectedAssignmentToPostpone.set(assignment ?? null);
    this.postponeReason.set('');
    this.showPostponeModal.set(true);
  }

  protected closePostponeModal(): void {
    this.showPostponeModal.set(false);
    this.selectedAssignmentToPostpone.set(null);
  }

  protected submitPostpone(): void {
    const currentMission = this.mission();
    const reason = this.postponeReason().trim();
    if (!currentMission || !reason) return;
    this.actionBusy.set(true);

    const assignment = this.selectedAssignmentToPostpone();
    const role = assignment?.assignmentRole || 'INSPECTOR';
    const userName =
      assignment?.userFullName || assignment?.userName || currentMission.assignedToUsername || 'Thành viên đội ngũ';

    this.api
      .postponeAssignment(currentMission.id, reason, assignment?.id, role, userName)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.actionBusy.set(false)),
      )
      .subscribe({
        next: (updated) => {
          this.mission.set(updated);
          this.showPostponeModal.set(false);
          this.actionMessage.set(`Đã gửi yêu cầu hoãn nhiệm vụ cho vai trò [${role}] tới Quản lý.`);
          this.notificationsStore.upsert({
            id: `notif-${Date.now()}`,
            userId: updated.managerId,
            title: `[MF02 CẢNH BÁO] Yêu cầu hoãn nhiệm vụ ${updated.missionCode}`,
            body: `[${role}] ${userName} đề xuất hoãn nhiệm vụ. Lý do: ${reason}`,
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
            assignmentId: assignment?.id,
            reason,
            actorRole: role,
            actorName: userName,
            timestamp: new Date().toISOString(),
          });
        },
        error: (err: unknown) => this.actionMessage.set(this.errorMessage(err)),
      });
  }

  protected startFlight(): void {
    const currentMission = this.mission();
    if (!currentMission) return;
    this.actionBusy.set(true);
    this.actionMessage.set('');

    this.api
      .start(currentMission.id)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        catchError(() => of(null)),
        finalize(() => this.actionBusy.set(false)),
      )
      .subscribe({
        next: () => {
          const now = new Date().toISOString();
          const newLog: MissionCommunicationLog = {
            id: `log-${Date.now()}`,
            senderId: this.auth.user()?.id || 'usr-pilot',
            senderName: currentMission.assignedToUsername || 'Phi công phụ trách',
            senderRole: 'INSPECTOR',
            type: 'START',
            content: 'UAV đã cất cánh. Bắt đầu hành trình bay khảo sát và quét LiDAR/Camera hành lang lưới điện.',
            timestamp: now,
          };
          this.mission.update((curr) =>
            curr
              ? {
                  ...curr,
                  status: 'Executing',
                  actualStart: now,
                  communicationLogs: [newLog, ...(curr.communicationLogs || [])],
                }
              : null,
          );
          this.actionMessage.set('Đã khởi động chuyến bay khảo sát! Trạng thái: Đang bay (Executing).');
          this.realtime.broadcastMissionEvent({
            missionId: currentMission.id,
            type: 'STARTED',
            status: 'Executing',
            actorRole: 'INSPECTOR',
            actorName: currentMission.assignedToUsername || 'Phi công phụ trách',
            reason: 'Bắt đầu hành trình bay khảo sát hiện trường.',
            timestamp: now,
          });
        },
        error: (err: unknown) => this.actionMessage.set(this.errorMessage(err)),
      });
  }

  protected completeFlight(): void {
    const currentMission = this.mission();
    if (!currentMission) return;
    this.actionBusy.set(true);
    this.actionMessage.set('');

    this.api
      .complete(currentMission.id)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        catchError(() => of(null)),
        finalize(() => this.actionBusy.set(false)),
      )
      .subscribe({
        next: () => {
          const now = new Date().toISOString();
          const newLog: MissionCommunicationLog = {
            id: `log-${Date.now()}`,
            senderId: this.auth.user()?.id || 'usr-pilot',
            senderName: currentMission.assignedToUsername || 'Phi công phụ trách',
            senderRole: 'INSPECTOR',
            type: 'COMPLETE',
            content:
              'UAV đã hạ cánh an toàn. Chuyến bay khảo sát hoàn tất. Sẵn sàng trích xuất thẻ nhớ SD/dữ liệu để nạp AI.',
            timestamp: now,
          };
          this.mission.update((curr) =>
            curr
              ? {
                  ...curr,
                  status: 'Completed',
                  actualCompleted: now,
                  communicationLogs: [newLog, ...(curr.communicationLogs || [])],
                }
              : null,
          );
          this.actionMessage.set('Chuyến bay khảo sát đã HOÀN TẤT! Cổng nạp dữ liệu ảnh/video UAV đã được mở khóa.');
          this.realtime.broadcastMissionEvent({
            missionId: currentMission.id,
            type: 'COMPLETED',
            status: 'Completed',
            actorRole: 'INSPECTOR',
            actorName: currentMission.assignedToUsername || 'Phi công phụ trách',
            reason: 'Hoàn tất bay khảo sát hiện trường.',
            timestamp: now,
          });
        },
        error: (err: unknown) => this.actionMessage.set(this.errorMessage(err)),
      });
  }

  protected openReassignModal(assignment: MissionAssignment): void {
    this.selectedAssignmentToReassign.set(assignment);
    this.reassignReason.set('');
    const pool = this.reassignCandidatePool();
    const candidate = pool.find((u) => u.id !== assignment.userId) || pool[0];
    this.reassignNewUserId.set(candidate?.id || '');
    this.showReassignModal.set(true);
  }

  protected closeReassignModal(): void {
    this.showReassignModal.set(false);
    this.selectedAssignmentToReassign.set(null);
  }

  protected submitReassign(): void {
    const currentMission = this.mission();
    const assignment = this.selectedAssignmentToReassign();
    const newUserId = this.reassignNewUserId();
    const reason = this.reassignReason().trim();
    if (!currentMission || !assignment || !newUserId || this.actionBusy()) return;

    this.actionBusy.set(true);
    this.api
      .reassignAssignment(currentMission.id, assignment.id, newUserId, reason)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.actionBusy.set(false)),
      )
      .subscribe({
        next: (updated) => {
          this.mission.set(updated);
          this.showReassignModal.set(false);
          const newUser = this.availableUsers().find((u) => u.id === newUserId);
          const newName = newUser?.fullName || newUser?.email || 'Thành viên mới';
          this.actionMessage.set(`Đã tái phân công vai trò ${assignment.assignmentRole} cho ${newName}.`);

          this.notificationsStore.upsert({
            id: `notif-${Date.now()}`,
            userId: newUserId,
            title: `[MF02 TÁI PHÂN CÔNG] Bạn được chỉ định vai trò ${assignment.assignmentRole}`,
            body: `Quản lý đã tái phân công bạn cho nhiệm vụ ${currentMission.missionCode}. Vui lòng kiểm tra và xác nhận.`,
            type: 'MISSION_DISPATCH',
            referenceType: 'MISSION',
            referenceId: currentMission.id,
            createdAt: new Date().toISOString(),
            isRead: false,
          });

          this.realtime.broadcastMissionEvent({
            missionId: currentMission.id,
            type: 'REASSIGNED',
            status: updated.status,
            actorRole: 'MANAGER',
            actorName: this.auth.user()?.fullName || 'Quản lý vận hành',
            assignmentId: assignment.id,
            reason: reason || 'Thay thế nhân sự xin hoãn',
            allConfirmed: updated.allConfirmed,
            confirmedCount: updated.confirmedCount,
            totalRequiredCount: updated.totalRequiredCount,
            pendingRoles: updated.pendingRoles,
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
    const senderName =
      role === 'MANAGER'
        ? currentMission.managerUsername || 'Quản lý vận hành'
        : currentMission.assignedToUsername || 'Phi công phụ trách';

    this.actionBusy.set(true);
    this.api
      .addMissionActivity(currentMission.id, content, role)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        catchError(() => this.api.sendCommunication(currentMission.id, content, role, senderName)),
        finalize(() => this.actionBusy.set(false)),
      )
      .subscribe({
        next: (res) => {
          if (res && typeof res === 'object' && 'id' in res && 'targets' in res) {
            this.mission.set(res as Mission);
          } else {
            const newLog: MissionCommunicationLog = {
              id: `log-${Date.now()}`,
              senderId: this.auth.user()?.id || 'usr-me',
              senderName,
              senderRole: role,
              type: 'MESSAGE',
              content,
              timestamp: new Date().toISOString(),
            };
            this.mission.update((curr) =>
              curr
                ? {
                    ...curr,
                    communicationLogs: [newLog, ...(curr.communicationLogs ?? [])],
                  }
                : null,
            );
          }
          this.chatMessage.set('');
          this.notificationsStore.upsert({
            id: `notif-${Date.now()}`,
            title: `[MF02 Tin nhắn] ${senderName} (${role === 'MANAGER' ? 'Quản lý' : 'Inspector'})`,
            body: content,
            type: 'MISSION_COMMUNICATION',
            referenceType: 'MISSION',
            referenceId: currentMission.id,
            createdAt: new Date().toISOString(),
            isRead: false,
          });
          this.realtime.broadcastMissionEvent({
            missionId: currentMission.id,
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
        PENDING_CONFIRMATION: 'Chờ 3 vai trò tiếp nhận',
        CONFIRMED: 'Đã xác nhận (Sẵn sàng bay)',
        POSTPONED: 'Yêu cầu hoãn/Điều chỉnh',
        SUSPENDED: 'Tạm đình chỉ bay',
        Cancelled: 'Đã hủy',
        Pending: 'Chờ xử lý',
        Draft: 'Bản nháp',
        Assigned: 'Đã xác nhận (Sẵn sàng bay)',
        Preparing: 'Đang chuẩn bị',
        Ready: 'Sẵn sàng bay',
        Executing: 'Đang bay khảo sát',
        InProgress: 'Đang bay khảo sát',
        'In Progress': 'Đang bay khảo sát',
        Completed: 'Đã hoàn tất chuyến bay',
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

  private loadAssignmentsOverview(missionId: string): void {
    this.api
      .getAssignmentsOverview(missionId)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        catchError(() => of(null)),
      )
      .subscribe({
        next: (overview) => {
          if (!overview) return;
          this.mission.update((curr) => {
            if (!curr) return null;
            return {
              ...curr,
              totalRequiredCount: overview.totalRequiredCount,
              confirmedCount: overview.confirmedCount,
              allConfirmed: overview.allConfirmed,
              confirmationProgress:
                overview.totalRequiredCount > 0 ? overview.confirmedCount / overview.totalRequiredCount : 0,
              confirmationDeadline: overview.confirmationDeadline || curr.confirmationDeadline,
              status: overview.allConfirmed ? 'CONFIRMED' : curr.status,
              team: overview.assignments && overview.assignments.length > 0 ? overview.assignments : curr.team,
            };
          });
        },
      });
  }

  private loadDetections(missionId: string): void {
    this.detectionsLoading.set(true);
    this.api
      .getMissionDetections(missionId)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        catchError(() => this.assetApi.getMissionDetections(missionId).pipe(catchError(() => of([])))),
        finalize(() => this.detectionsLoading.set(false)),
      )
      .subscribe({
        next: (detections) => {
          const mapped = detections.map((item) => this.mapDetection(item));
          this.resultPage.set(1);
          this.detections.set(mapped);
          this.selectedDetection.set(mapped[0] ?? null);
          this.syncAssetsWithDetections(this.mission()?.targets ?? [], mapped);
        },
        error: () => {
          this.resultPage.set(1);
          this.detections.set([]);
          this.selectedDetection.set(null);
        },
      });
  }

  private syncAssetsWithDetections(
    targets: readonly MissionTarget[],
    detections: readonly MissionDetectionView[],
  ): void {
    if (!targets.length) return;
    const approved = detections.filter((d) => d.status === 'Approved' || d.status === 'Accepted');
    const assetList: MissionAssetItem[] = targets.map((t, idx) => {
      const relatedDetections = approved.filter(
        (d) =>
          d.assetId === t.assetId ||
          (t.towerCode && d.tower.includes(t.towerCode)) ||
          (idx === 0 && approved.length > 0),
      );
      const defectCount = relatedDetections.length;
      const totalPenalty = relatedDetections.reduce((sum, d) => sum + (d.severityWeight || 1) * 20, 0);
      const score = Math.max(25, 98 - totalPenalty);
      const risk: MissionAssetItem['riskLevel'] =
        score < 40 ? 'Critical Risk' : score < 60 ? 'High Risk' : score < 80 ? 'Medium Risk' : 'Low Risk';
      const status: MissionAssetItem['status'] =
        score < 50 ? 'Maintenance' : score < 75 ? 'InspectionRequired' : 'Operational';

      return {
        id: t.assetId || `ast-${idx + 1}`,
        code: t.assetCode || `AST-220KV-04${idx + 1}`,
        type: t.assetName || (t.assetType === 'TOWER' ? 'Cột néo truyền tải 220kV' : 'Chuỗi sứ cách điện đỡ'),
        towerCode: t.towerCode || `Cột 04${idx + 1}`,
        healthScore: score,
        riskLevel: risk,
        defectCount,
        status,
        lastInspected: '27/08/2026 14:20',
      };
    });
    this.missionAssets.set(assetList);
  }

  private loadMaintenanceTasks(missionId: string): void {
    this.api
      .getMissionMaintenanceTasks(missionId)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        catchError(() => of([])),
      )
      .subscribe({
        next: (tasks) => {
          const mapped: MissionMaintenanceTask[] = tasks.map((t) => ({
            id: t.id,
            title: t.title,
            priority: (t.priority === 'Urgent' || t.priority === 'High' || t.priority === 'Medium' || t.priority === 'Scheduled'
              ? t.priority
              : t.priority === 'Low'
              ? 'Scheduled'
              : 'Medium') as MissionMaintenanceTask['priority'],
            towerCode: t.towerCode || 'Cột 042 (Néo)',
            assetCode: t.assetCode || 'INS-220KV-042',
            defectDescription: t.defectDescription || 'Khuyết tật xác nhận bởi AI & Analyst',
            suggestedAction: t.suggestedAction || 'Bảo dưỡng / Thay thế thiết bị',
            status: (t.status === 'Approved' || t.status === 'InProgress' || t.status === 'Completed'
              ? t.status
              : 'Pending') as MissionMaintenanceTask['status'],
            assignedTeam: t.assignedTeam || 'Đội Truyền tải / Bảo dưỡng EVN',
          }));
          this.maintenanceTasks.set(mapped);
        },
        error: () => this.maintenanceTasks.set([]),
      });
  }

  private loadActivities(missionId: string): void {
    this.api
      .getMissionActivities(missionId)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        catchError(() => of([])),
      )
      .subscribe({
        next: (activities) => {
          if (!activities || !activities.length) return;
          const logs: MissionCommunicationLog[] = activities.map((a) => ({
            id: a.id,
            senderId: a.senderUserId || 'user',
            senderName: a.senderName,
            senderRole: (a.senderRole?.toUpperCase() === 'MANAGER'
              ? 'MANAGER'
              : a.senderRole?.toUpperCase() === 'INSPECTOR'
              ? 'INSPECTOR'
              : 'SYSTEM') as 'MANAGER' | 'INSPECTOR' | 'SYSTEM',
            type: 'MESSAGE',
            content: a.content,
            timestamp: a.timestamp,
          }));
          this.mission.update((curr) => {
            if (!curr) return null;
            const existing = curr.communicationLogs ?? [];
            const merged = [...logs];
            for (const l of existing) {
              if (
                !merged.some(
                  (m) =>
                    m.id === l.id ||
                    (m.content === l.content &&
                      Math.abs(new Date(m.timestamp).getTime() - new Date(l.timestamp).getTime()) < 3000),
                )
              ) {
                merged.push(l);
              }
            }
            merged.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
            return { ...curr, communicationLogs: merged };
          });
        },
      });
  }

  private mapDetection(item: MissionBackendDetection | MissionAiDetection): MissionDetectionView {
    const tsSec = item.timestampSeconds ?? null;
    const durSec =
      ('videoDurationSeconds' in item ? item.videoDurationSeconds : null) ?? (tsSec ? Math.max(60, tsSec + 10) : 60);
    const tsLabel =
      'timestampLabel' in item && item.timestampLabel
        ? item.timestampLabel
        : tsSec !== null
        ? this.formatTime(tsSec)
        : item.frameIndex !== null && item.frameIndex !== undefined
        ? `Frame ${item.frameIndex}`
        : 'N/A';

    const rawNotes = 'reviewNotes' in item ? item.reviewNotes : 'analystNotes' in item ? item.analystNotes : '';
    const rawValidatedAt = 'reviewedAt' in item ? item.reviewedAt : 'validatedAt' in item ? item.validatedAt : '';

    return {
      id: item.id,
      mediaId: item.mediaId || '',
      title: item.title,
      confidence: Math.round(item.confidence <= 1 && item.confidence > 0 ? item.confidence * 100 : item.confidence),
      timestampLabel: tsLabel,
      timestampSeconds: tsSec,
      frameIndex: item.frameIndex ?? null,
      videoDurationLabel: this.formatTime(durSec),
      status: item.status,
      mediaStatus: ('mediaStatus' in item ? item.mediaStatus : 'Analyzed') || 'Analyzed',
      categoryCode: item.categoryCode || 'DEFECT',
      severityWeight: item.severityWeight ?? 1,
      isEmergency: item.isEmergency ?? false,
      aiSource: ('aiSource' in item ? item.aiSource : 'SERVER') || 'SERVER',
      mediaType: ('mediaType' in item ? item.mediaType : tsSec !== null ? 'video' : 'image') || 'image',
      sourceUrl: item.sourceUrl,
      imageUrl: item.imageUrl || item.sourceUrl || '/images/defect-insulator-crack.png',
      cropImageUrl: item.imageUrl || item.sourceUrl || '/images/defect-insulator-crack.png',
      boundingBox: item.boundingBox,
      missionId: item.missionId,
      assetId: item.assetId || 'Chưa liên kết',
      tower: ('tower' in item && item.tower ? item.tower : 'Cột 042 (TOW-220KV-042)'),
      gps: ('gps' in item && item.gps ? item.gps : '20°58\'14.2"N 105°48\'22.6"E'),
      description: item.description || 'Không có mô tả từ máy chủ AI.',
      notes: rawNotes || '',
      detectedAt: item.detectedAt || new Date().toISOString(),
      validatedAt: rawValidatedAt || '',
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
      this.mission.update((curr) => {
        if (!curr) return null;
        let updatedTeam = curr.team;
        if (event.assignmentId && curr.team) {
          updatedTeam = curr.team.map((a) =>
            a.id === event.assignmentId
              ? { ...a, responseStatus: 'ACCEPTED' as const, respondedAt: event.timestamp || new Date().toISOString() }
              : a,
          );
        }
        const totalReq = event.totalRequiredCount ?? curr.totalRequiredCount ?? (updatedTeam ? updatedTeam.length : 3);
        const confCount = event.confirmedCount ?? (updatedTeam ? updatedTeam.filter((a) => a.responseStatus === 'ACCEPTED').length : 1);
        const isAllConfirmed = event.allConfirmed ?? (confCount >= totalReq);

        return {
          ...curr,
          status: isAllConfirmed ? 'CONFIRMED' : 'PENDING_CONFIRMATION',
          confirmedAt: isAllConfirmed ? (event.timestamp || new Date().toISOString()) : (curr.confirmedAt ?? null),
          allConfirmed: isAllConfirmed,
          confirmedCount: confCount,
          totalRequiredCount: totalReq,
          confirmationProgress: totalReq > 0 ? confCount / totalReq : 0,
          team: updatedTeam,
        };
      });

      if (event.allConfirmed) {
        this.actionMessage.set(`[THỰC THỜI] 100% các vai trò (Inspector, Analyst, Technician) đã chấp thuận! Nhiệm vụ ${event.missionId} chính thức SẴN SÀNG BAY.`);
      } else {
        this.actionMessage.set(`[THỰC THỜI] ${event.actorName || 'Thành viên'} (${event.actorRole || 'Thành viên'}) đã xác nhận tiếp nhận. (${event.confirmedCount ?? 1}/${event.totalRequiredCount ?? 3} đã xác nhận).`);
      }
    } else if (event.type === 'POSTPONED') {
      this.mission.update((curr) => {
        if (!curr) return null;
        let updatedTeam = curr.team;
        if (event.assignmentId && curr.team) {
          updatedTeam = curr.team.map((a) =>
            a.id === event.assignmentId
              ? { ...a, responseStatus: 'POSTPONED' as const, responseReason: event.reason }
              : a,
          );
        }
        return {
          ...curr,
          status: 'POSTPONED',
          postponeReason: event.reason || curr.postponeReason,
          team: updatedTeam,
          requiresReassignment: true,
        };
      });
      this.actionMessage.set(`[CẢNH BÁO THỰC THỜI] Thành viên ${event.actorName || 'Đội bay'} (${event.actorRole || ''}) yêu cầu hoãn: "${event.reason || ''}". Quản lý có thể tái phân công ngay vai trò này.`);
    } else if (event.type === 'REASSIGNED') {
      this.actionMessage.set(`[THỰC THỜI] Quản lý đã tái phân công nhân sự mới cho vai trò ${event.actorRole || 'Đội bay'}.`);
      this.api.get(currentMission.id).subscribe({
        next: (fresh) => this.mission.set(fresh),
      });
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
