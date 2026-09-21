import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { PreMissionAssessment } from '../../../../models/pre-mission.models';
import { statusLabel, statusTone } from '../../../../shared/status/status';
import { GisApi } from '../../../gis/data-access/gis-api';
import { PreMissionApi } from '../../data-access/pre-mission-api';

@Component({
  selector: 'app-assessment-list',
  imports: [RouterLink, DatePipe, NzIconModule],
  templateUrl: './assessment-list.html',
  styleUrl: './assessment-list.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AssessmentList {
  private readonly api = inject(PreMissionApi);
  private readonly gisApi = inject(GisApi);

  protected readonly loading = signal(true);
  protected readonly actionBusyId = signal<string | null>(null);
  protected readonly error = signal('');
  protected readonly successMessage = signal('');
  protected readonly items = signal<readonly PreMissionAssessment[]>([]);
  protected readonly page = signal(1);
  protected readonly pageSize = signal(10);
  protected readonly totalCount = signal(0);
  protected readonly totalPages = signal(1);

  // Filters
  protected readonly statusFilter = signal('');
  protected readonly regionFilter = signal('');
  protected readonly lineFilter = signal('');
  protected readonly dateFilter = signal('');
  protected readonly searchQuery = signal('');

  protected readonly regions = signal<readonly { id: string; name: string }[]>([]);
  protected readonly availableLines = signal<readonly { id: string; lineName: string }[]>([]);

  protected readonly statuses = [
    { value: '', label: 'Tất cả trạng thái' },
    { value: 'READY', label: 'Sẵn sàng (READY)' },
    { value: 'NOT_READY', label: 'Chưa sẵn sàng (NOT_READY)' },
    { value: 'EVALUATING', label: 'Đang đánh giá (EVALUATING)' },
    { value: 'DRAFT', label: 'Bản nháp (DRAFT)' },
    { value: 'EXPIRED', label: 'Hết hạn (EXPIRED)' },
    { value: 'CONSUMED', label: 'Đã tạo nhiệm vụ (CONSUMED)' },
    { value: 'CANCELLED', label: 'Đã hủy (CANCELLED)' },
  ];

  protected readonly filteredItems = computed(() => {
    const q = this.searchQuery().trim().toLowerCase();
    const region = this.regionFilter();
    const line = this.lineFilter();
    const date = this.dateFilter();
    let list = this.items();

    if (region) {
      list = list.filter(
        (item) => item.regionId === region || item.regionName.toLowerCase() === region.toLowerCase()
      );
    }

    if (line) {
      list = list.filter(
        (item) => item.lineName?.toLowerCase() === line.toLowerCase() || item.lineId === line
      );
    }

    if (date) {
      list = list.filter((item) => item.plannedStart.startsWith(date));
    }

    if (q) {
      list = list.filter(
        (item) =>
          item.assessmentCode.toLowerCase().includes(q) ||
          item.regionName.toLowerCase().includes(q) ||
          (item.lineName && item.lineName.toLowerCase().includes(q)) ||
          (item.createdBy && item.createdBy.toLowerCase().includes(q))
      );
    }

    return list;
  });

  protected readonly stats = computed(() => {
    const list = this.items();
    return [
      { label: 'Tổng số đánh giá', value: this.totalCount() || list.length },
      { label: 'Sẵn sàng (READY)', value: list.filter((x) => x.status === 'READY').length },
      { label: 'Chưa sẵn sàng (NOT_READY)', value: list.filter((x) => x.status === 'NOT_READY').length },
      {
        label: 'Hết hạn / Tiêu thụ / Hủy',
        value: list.filter((x) => x.status === 'EXPIRED' || x.status === 'CONSUMED' || x.status === 'CANCELLED').length,
      },
    ];
  });

  protected readonly startIndex = computed(() => {
    if (!this.totalCount()) return 0;
    return (this.page() - 1) * this.pageSize() + 1;
  });

  protected readonly endIndex = computed(() => {
    return Math.min(this.page() * this.pageSize(), this.totalCount() || this.items().length);
  });

  protected readonly pageButtons = computed(() => {
    const total = this.totalPages();
    const current = this.page();
    const buttons: number[] = [];
    for (let i = 1; i <= total; i++) {
      if (i === 1 || i === total || (i >= current - 2 && i <= current + 2)) {
        buttons.push(i);
      }
    }
    return buttons;
  });

  constructor() {
    this.loadRegions();
    this.loadLines('');
    this.load();
  }

  private loadRegions(): void {
    this.gisApi.getRegions().subscribe({
      next: (data) => this.regions.set(data),
      error: (err) => console.warn('Failed to load regions', err),
    });
  }

  private loadLines(regionId: string): void {
    const filter = regionId ? { administrativeAreaId: regionId } : undefined;
    this.gisApi.getAllGisData(filter).subscribe({
      next: (data) => this.availableLines.set(data.lines),
      error: (err: unknown) => console.warn('Failed to load lines', err),
    });
  }

  protected load(): void {
    this.loading.set(true);
    this.error.set('');
    this.api
      .list({
        page: this.page(),
        pageSize: this.pageSize(),
        status: this.statusFilter(),
        regionId: this.regionFilter(),
        lineName: this.lineFilter(),
        plannedDate: this.dateFilter(),
        search: this.searchQuery(),
      })
      .subscribe({
        next: (res) => {
          this.items.set(res.items);
          this.page.set(res.page);
          this.pageSize.set(res.pageSize);
          this.totalCount.set(res.totalCount);
          this.totalPages.set(res.totalPages);
        },
        error: () => {
          this.error.set('Không tải được danh sách đánh giá tiền nhiệm vụ. Vui lòng thử lại.');
        },
        complete: () => {
          this.loading.set(false);
        },
      });
  }

  protected onStatusChange(status: string): void {
    this.statusFilter.set(status);
    this.page.set(1);
    this.load();
  }

  protected onRegionChange(regionId: string): void {
    this.regionFilter.set(regionId);
    this.lineFilter.set('');
    this.loadLines(regionId);
    this.page.set(1);
    this.load();
  }

  protected onLineChange(lineName: string): void {
    this.lineFilter.set(lineName);
    this.page.set(1);
    this.load();
  }

  protected onDateChange(date: string): void {
    this.dateFilter.set(date);
    this.page.set(1);
    this.load();
  }

  protected onSearch(value: string): void {
    this.searchQuery.set(value);
  }

  protected resetFilters(): void {
    this.statusFilter.set('');
    this.regionFilter.set('');
    this.lineFilter.set('');
    this.dateFilter.set('');
    this.searchQuery.set('');
    this.page.set(1);
    this.load();
  }

  protected reevaluateItem(item: PreMissionAssessment, event: Event): void {
    event.stopPropagation();
    if (this.actionBusyId()) return;
    this.actionBusyId.set(item.id);
    this.error.set('');
    this.successMessage.set('');

    this.api.reEvaluate(item.id).subscribe({
      next: (updated) => {
        this.items.update((list) => list.map((x) => (x.id === updated.id ? updated : x)));
        this.successMessage.set(`Đã đánh giá lại thành công cho mã ${item.assessmentCode}.`);
      },
      error: (err) => {
        this.error.set(err?.error?.message || `Không thể đánh giá lại mã ${item.assessmentCode}.`);
      },
      complete: () => {
        this.actionBusyId.set(null);
      },
    });
  }

  protected cancelItem(item: PreMissionAssessment, event: Event): void {
    event.stopPropagation();
    if (this.actionBusyId()) return;
    if (item.status === 'CONSUMED') {
      this.error.set('Không thể hủy đánh giá đã được tiêu thụ tạo nhiệm vụ.');
      return;
    }

    const confirmed = window.confirm(`Bạn có chắc chắn muốn hủy bản đánh giá tiền nhiệm vụ ${item.assessmentCode}?`);
    if (!confirmed) return;

    this.actionBusyId.set(item.id);
    this.error.set('');
    this.successMessage.set('');

    this.api.cancel(item.id, 'Người dùng hủy từ danh sách').subscribe({
      next: (cancelled) => {
        this.items.update((list) => list.map((x) => (x.id === cancelled.id ? cancelled : x)));
        this.successMessage.set(`Đã hủy bản đánh giá ${item.assessmentCode}.`);
      },
      error: (err) => {
        this.error.set(err?.error?.message || `Không thể hủy mã ${item.assessmentCode}.`);
      },
      complete: () => {
        this.actionBusyId.set(null);
      },
    });
  }

  protected goToPage(targetPage: number): void {
    if (targetPage < 1 || targetPage > this.totalPages() || targetPage === this.page()) return;
    this.page.set(targetPage);
    this.load();
  }

  protected statusTone = statusTone;
  protected statusLabel = statusLabel;
}
