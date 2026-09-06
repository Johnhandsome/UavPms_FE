import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
  effect,
} from '@angular/core';
import { CommonModule, DatePipe } from '@angular/common';
import { FormsModule, ReactiveFormsModule, FormBuilder, Validators } from '@angular/forms';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { NzButtonModule } from 'ng-zorro-antd/button';
import { NzTagModule } from 'ng-zorro-antd/tag';
import { NzModalModule } from 'ng-zorro-antd/modal';
import { NzInputModule } from 'ng-zorro-antd/input';
import { NzSelectModule } from 'ng-zorro-antd/select';
import { NzBadgeModule } from 'ng-zorro-antd/badge';
import { NzNotificationService } from 'ng-zorro-antd/notification';
import { NzTooltipModule } from 'ng-zorro-antd/tooltip';
import { NzTableModule } from 'ng-zorro-antd/table';

import { Auth } from '../../../../core/auth/auth';
import { NotificationsRealtime } from '../../../notifications/data-access/notifications-realtime';
import { EmergencyAlertsApi } from '../../data-access/emergency-alerts-api';
import {
  EmergencyAlertItem,
  EscalationManagerOption,
} from '../../models/emergency-alert.models';

interface BoundingBoxStyle {
  left: string;
  top: string;
  width: string;
  height: string;
}

@Component({
  selector: 'app-emergency-alerts-review',
  standalone: true,
  imports: [
    CommonModule,
    DatePipe,
    FormsModule,
    ReactiveFormsModule,
    NzIconModule,
    NzButtonModule,
    NzTagModule,
    NzModalModule,
    NzInputModule,
    NzSelectModule,
    NzBadgeModule,
    NzTooltipModule,
    NzTableModule,
  ],
  templateUrl: './emergency-alerts-review.html',
  styleUrl: './emergency-alerts-review.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class EmergencyAlertsReview {
  private readonly fb = inject(FormBuilder);
  private readonly auth = inject(Auth);
  private readonly api = inject(EmergencyAlertsApi);
  private readonly realtime = inject(NotificationsRealtime);
  private readonly notification = inject(NzNotificationService);
  private readonly destroyRef = inject(DestroyRef);

  // Tab State: 'active' | 'history'
  protected readonly selectedTab = signal<'active' | 'history'>('active');

  // Active Alert selection
  protected readonly activeAlerts = this.api.activeAlerts;
  protected readonly historyAlerts = this.api.historyAlerts;
  protected readonly managers = this.api.managers;
  protected readonly activeCount = this.api.activeCount;

  protected readonly selectedAlertId = signal<string | null>(null);
  protected readonly selectedAlert = computed<EmergencyAlertItem | null>(() => {
    const id = this.selectedAlertId();
    if (!id) return this.activeAlerts()[0] || null;
    return this.activeAlerts().find((a) => a.id === id) || this.activeAlerts()[0] || null;
  });

  // Role permissions check
  protected readonly user = computed(() => this.auth.user());
  protected readonly canReview = computed(() => {
    const role = (this.user()?.role || '').toLowerCase();
    return (
      role === 'analyst' ||
      role === 'admin' ||
      role === 'systemadmin' ||
      role === 'administrator' ||
      role === 'manager' ||
      role === 'supervisor'
    );
  });

  // Image inspection & Zoom
  protected readonly zoomLevel = signal<number>(1);
  protected readonly showBoundingBox = signal<boolean>(true);
  protected readonly imgNaturalWidth = signal<number>(800);
  protected readonly imgNaturalHeight = signal<number>(600);

  // History Tab Filter
  protected readonly historyFilterStatus = signal<string>('ALL');
  protected readonly filteredHistoryAlerts = computed(() => {
    const filter = this.historyFilterStatus();
    const list = this.historyAlerts();
    if (filter === 'ALL') return list;
    return list.filter((a) => a.status.toUpperCase() === filter.toUpperCase());
  });

  // Modals & Action Busy
  protected readonly actionBusy = signal<boolean>(false);
  protected readonly isConfirmModalVisible = signal<boolean>(false);
  protected readonly isRejectModalVisible = signal<boolean>(false);
  protected readonly isEscalateModalVisible = signal<boolean>(false);

  // Inspection history modal for viewing archived item
  protected readonly inspectingHistoryItem = signal<EmergencyAlertItem | null>(null);

  // Forms
  protected readonly confirmNotes = signal<string>('Xác nh?n s? c? de d?a an toàn truy?n t?i chính xác qua ?nh b?ng ch?ng UAV.');
  protected readonly rejectReason = signal<string>('Báo d?ng gi? (False positive - lá cây/ph?n x? ánh sáng)');
  protected readonly rejectNotes = signal<string>('');

  protected readonly escalateForm = this.fb.group({
    escalatedToUserId: ['', [Validators.required]],
    urgencyLevel: ['C?p bách (Kh?n c?p c?p 1)'],
    reason: ['', [Validators.required, Validators.minLength(10)]],
  });

  // Real-time audio context
  private audioCtx: AudioContext | null = null;

  constructor() {
    // Initial fetch
    this.api.fetchActiveAlerts().pipe(takeUntilDestroyed()).subscribe();
    this.api.fetchAlertHistory().pipe(takeUntilDestroyed()).subscribe();

    // Auto select first alert if not selected
    effect(() => {
      const active = this.activeAlerts();
      if (!this.selectedAlertId() && active.length > 0) {
        this.selectedAlertId.set(active[0].id);
      }
    });

    // Listen to real-time SignalR notifications
    this.initRealtimeSubscription();
  }

  private initRealtimeSubscription(): void {
    // Connect websocket if not already connected
    this.realtime.connect();

    this.realtime.notifications$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((notif) => {
        const raw = notif as unknown as Record<string, unknown>;
        const priority = String(raw['priority'] || '').toUpperCase();
        const isEmergency =
          notif.type === 'EmergencyAlert' ||
          notif.referenceType === 'EmergencyAlert' ||
          priority === 'HIGH' ||
          priority === 'CRITICAL';

        if (isEmergency) {
          // Play audible warning alert
          this.playWarningBeep();

          // Display prominent toast
          this.notification.error(
            '?? C?NH BÁO KH?N C?P M?I (EDGE AI)',
            `${notif.title}: ${notif.body}`,
            { nzDuration: 8000, nzPauseOnHover: true },
          );

          // Fetch or ingest
          this.api.fetchActiveAlerts().subscribe();
        }
      });
  }

  // --- AUDIO SYNTHESIS ALERT BEEP ---
  private playWarningBeep(): void {
    try {
      const ctx = this.audioCtx || new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      this.audioCtx = ctx;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(880, ctx.currentTime); // A5
      osc.frequency.setValueAtTime(660, ctx.currentTime + 0.15); // E5
      osc.frequency.setValueAtTime(880, ctx.currentTime + 0.3); // A5

      gain.gain.setValueAtTime(0.3, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.6);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start();
      osc.stop(ctx.currentTime + 0.6);
    } catch (e) {
      console.warn('Audio alert not supported or user has not interacted yet', e);
    }
  }

  // --- MANUAL SIMULATION TRIGGER ---
  protected onSimulateIncomingAlert(): void {
    const alert = this.api.simulateRealtimeAlert();
    this.playWarningBeep();
    this.selectedAlertId.set(alert.id);
    this.notification.create(
      'error',
      '?? [SIMULATION] C?nh báo Edge AI v?a g?i v?',
      `Phát hi?n: ${alert.title} t?i ${alert.towerCode}`,
      { nzDuration: 6000 },
    );
  }

  // --- SELECTION & ZOOM ---
  protected selectAlert(alert: EmergencyAlertItem): void {
    this.selectedAlertId.set(alert.id);
    this.zoomLevel.set(1);
  }

  protected onImageLoaded(event: Event): void {
    const img = event.target as HTMLImageElement;
    this.imgNaturalWidth.set(img.naturalWidth || 800);
    this.imgNaturalHeight.set(img.naturalHeight || 600);
  }

  protected zoomIn(): void {
    this.zoomLevel.update((z) => Math.min(2.5, +(z + 0.25).toFixed(2)));
  }

  protected zoomOut(): void {
    this.zoomLevel.update((z) => Math.max(0.75, +(z - 0.25).toFixed(2)));
  }

  protected resetZoom(): void {
    this.zoomLevel.set(1);
  }

  protected toggleBoundingBox(): void {
    this.showBoundingBox.update((v) => !v);
  }

  protected getBoundingBoxStyle(box: { x: number; y: number; width: number; height: number; isNormalized?: boolean } | undefined): BoundingBoxStyle | null {
    if (!box) return null;
    if (box.isNormalized || (box.x <= 100 && box.y <= 100 && box.width <= 100 && box.height <= 100)) {
      return {
        left: `${box.x}%`,
        top: `${box.y}%`,
        width: `${box.width}%`,
        height: `${box.height}%`,
      };
    }
    const naturalW = this.imgNaturalWidth();
    const naturalH = this.imgNaturalHeight();
    if (naturalW > 0 && naturalH > 0) {
      return {
        left: `${(box.x / naturalW) * 100}%`,
        top: `${(box.y / naturalH) * 100}%`,
        width: `${(box.width / naturalW) * 100}%`,
        height: `${(box.height / naturalH) * 100}%`,
      };
    }
    return { left: '35%', top: '30%', width: '30%', height: '35%' };
  }

  // --- ACTION 1: CONFIRM (XÁC NH?N S? C?) ---
  protected openConfirmModal(): void {
    if (!this.canReview()) return;
    this.confirmNotes.set('Xác nh?n s? c? de d?a an toàn lu?i di?n chính xác qua ?nh b?ng ch?ng UAV.');
    this.isConfirmModalVisible.set(true);
  }

  protected closeConfirmModal(): void {
    if (this.actionBusy()) return;
    this.isConfirmModalVisible.set(false);
  }

  protected executeConfirm(): void {
    const alert = this.selectedAlert();
    if (!alert || this.actionBusy()) return;

    this.actionBusy.set(true);
    this.api
      .reviewAlert(alert.id, {
        status: 'Confirmed',
        notes: this.confirmNotes().trim() || 'Xác nh?n s? c? chính xác.',
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.actionBusy.set(false);
          this.isConfirmModalVisible.set(false);
          this.notification.success(
            'Th?m Ð?nh Thành Công',
            `Ðã xác nh?n s? c? #${alert.id} và dua vào danh sách s? c? k? thu?t chính th?c.`,
          );
        },
        error: (err) => {
          this.actionBusy.set(false);
          this.notification.error('L?i th?m d?nh', err?.message || 'Không th? x? lý yêu c?u.');
        },
      });
  }

  // --- ACTION 2: REJECT / DISMISS (BÁC B?) ---
  protected openRejectModal(): void {
    if (!this.canReview()) return;
    this.rejectReason.set('Báo d?ng gi? (False positive - lá cây/ph?n x? ánh sáng)');
    this.rejectNotes.set('');
    this.isRejectModalVisible.set(true);
  }

  protected closeRejectModal(): void {
    if (this.actionBusy()) return;
    this.isRejectModalVisible.set(false);
  }

  protected executeReject(): void {
    const alert = this.selectedAlert();
    if (!alert || this.actionBusy()) return;

    const fullNote = `[${this.rejectReason()}] ${this.rejectNotes().trim() || 'Bác b? nh?n di?n AI.'}`;
    this.actionBusy.set(true);

    this.api
      .reviewAlert(alert.id, {
        status: 'Dismissed',
        notes: fullNote,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.actionBusy.set(false);
          this.isRejectModalVisible.set(false);
          this.notification.info(
            'Ðã Bác B? C?nh Báo',
            `C?nh báo #${alert.id} dã du?c dánh d?u là không ph?i s? c? kh?n c?p.`,
          );
        },
        error: (err) => {
          this.actionBusy.set(false);
          this.notification.error('L?i x? lý', err?.message || 'Không th? bác b? c?nh báo.');
        },
      });
  }

  // --- ACTION 3: ESCALATE (LEO THANG KH?N C?P) ---
  protected openEscalateModal(): void {
    if (!this.canReview()) return;
    const managers = this.managers();
    this.escalateForm.reset({
      escalatedToUserId: managers[0]?.id || '',
      urgencyLevel: 'C?p bách (Kh?n c?p c?p 1)',
      reason: 'Phát hi?n s? c? nghiêm tr?ng de d?a rã lu?i ho?c m?t an toàn du?ng dây truy?n t?i. Kính d? ngh? lãnh d?o di?u d?ng l?c lu?ng ki?m tra hi?n tru?ng ngay.',
    });
    this.isEscalateModalVisible.set(true);
  }

  protected closeEscalateModal(): void {
    if (this.actionBusy()) return;
    this.isEscalateModalVisible.set(false);
  }

  protected executeEscalate(): void {
    const alert = this.selectedAlert();
    if (!alert || this.actionBusy() || this.escalateForm.invalid) {
      this.escalateForm.markAllAsTouched();
      return;
    }

    const val = this.escalateForm.getRawValue();
    const reasonText = (val.reason || '').trim();
    this.actionBusy.set(true);

    this.api
      .escalateAlert(alert.id, {
        escalatedToUserId: val.escalatedToUserId || '',
        reason: `[${val.urgencyLevel}] ${reasonText}`,
      })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => {
          this.actionBusy.set(false);
          this.isEscalateModalVisible.set(false);
          this.notification.warning(
            '?? Báo Cáo Leo Thang Kh?n C?p Thành Công',
            `Ðã chuy?n ti?p h? so s? c? #${alert.id} t?i C?p Qu?n lý & Trung tâm Ði?u d?.`,
            { nzDuration: 7000 },
          );
        },
        error: (err) => {
          this.actionBusy.set(false);
          this.notification.error('L?i leo thang', err?.message || 'Không th? g?i báo cáo leo thang.');
        },
      });
  }

  // Inspect history archived item modal
  protected viewHistoryItem(item: EmergencyAlertItem): void {
    this.inspectingHistoryItem.set(item);
  }

  protected closeHistoryDetailModal(): void {
    this.inspectingHistoryItem.set(null);
  }
}
