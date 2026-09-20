import { CommonModule, DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NzIconModule } from 'ng-zorro-antd/icon';
import {
  PowerLineOption,
  ReportCreateRequest,
  ReportItem,
  ReportStatistics,
  ReportStatus,
  ReportType,
  SubstationOption,
} from '../../../../models/reports.models';
import { ReportsApi } from '../../data-access/reports-api';

@Component({
  selector: 'app-reports-page',
  imports: [CommonModule, FormsModule, NzIconModule, DatePipe],
  templateUrl: './reports-page.html',
  styleUrl: './reports-page.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ReportsPage implements OnInit {
  private readonly reportsApi = inject(ReportsApi);

  // State signals
  protected readonly reports = signal<readonly ReportItem[]>([]);
  protected readonly isLoading = signal<boolean>(false);
  protected readonly isDownloading = signal<string | null>(null);
  protected readonly isSubmitting = signal<boolean>(false);
  protected readonly toastMessage = signal<string | null>(null);
  protected readonly toastType = signal<'success' | 'error' | 'info'>('success');

  // Filter signals
  protected readonly searchQuery = signal<string>('');
  protected readonly selectedType = signal<string>('all');
  protected readonly selectedStatus = signal<string>('all');
  protected readonly currentPage = signal<number>(1);
  protected readonly pageSize = signal<number>(10);
  protected readonly totalItems = signal<number>(0);
  protected readonly totalPages = signal<number>(1);

  // Statistics signal
  protected readonly stats = signal<ReportStatistics>({
    total: 0,
    byType: { defect: 0, periodic: 0, thermal: 0, corridor: 0 },
    byStatus: { approved: 0, pending: 0, draft: 0 },
  });

  // Modal & Lookup signals
  protected readonly isCreateModalOpen = signal<boolean>(false);
  protected readonly powerLines = signal<readonly PowerLineOption[]>([]);
  protected readonly substations = signal<readonly SubstationOption[]>([]);
  protected readonly targetCategory = signal<'line' | 'substation'>('line');
  protected readonly selectedLineId = signal<string>('');
  protected readonly selectedSubstationId = signal<string>('');
  protected readonly newReportTitle = signal<string>('');
  protected readonly newReportType = signal<ReportType>('defect');
  protected readonly newReportDescription = signal<string>('');

  private searchDebounceTimer?: ReturnType<typeof setTimeout>;

  ngOnInit(): void {
    this.loadReports();
    this.loadStatistics();
    this.loadLookups();
  }

  protected loadReports(): void {
    this.isLoading.set(true);
    this.reportsApi
      .listReports({
        search: this.searchQuery(),
        type: this.selectedType(),
        status: this.selectedStatus(),
        page: this.currentPage(),
        pageSize: this.pageSize(),
        sortBy: 'createdAt',
        sortOrder: 'desc',
      })
      .subscribe({
        next: (result) => {
          this.reports.set(result.items);
          this.totalItems.set(result.pagination.totalItems);
          this.totalPages.set(result.pagination.totalPages);
          this.currentPage.set(result.pagination.page);
          this.isLoading.set(false);
        },
        error: (err) => {
          console.error('Failed to load reports:', err);
          this.isLoading.set(false);
          this.showToast('Không thể tải danh sách báo cáo. Vui lòng thử lại.', 'error');
        },
      });
  }

  protected loadStatistics(): void {
    this.reportsApi.getStatistics().subscribe({
      next: (data) => {
        this.stats.set(data);
      },
      error: (err) => {
        console.error('Failed to load statistics:', err);
      },
    });
  }

  private loadLookups(): void {
    this.reportsApi.getLines().subscribe({
      next: (lines) => {
        this.powerLines.set(lines);
        if (lines.length > 0 && !this.selectedLineId()) {
          this.selectedLineId.set(lines[0].id);
        }
      },
    });

    this.reportsApi.getSubstations().subscribe({
      next: (subs) => {
        this.substations.set(subs);
        if (subs.length > 0 && !this.selectedSubstationId()) {
          this.selectedSubstationId.set(subs[0].id);
        }
      },
    });
  }

  protected onSearchInput(val: string): void {
    this.searchQuery.set(val);
    if (this.searchDebounceTimer) {
      clearTimeout(this.searchDebounceTimer);
    }
    this.searchDebounceTimer = setTimeout(() => {
      this.currentPage.set(1);
      this.loadReports();
    }, 350);
  }

  protected onTypeChange(type: string): void {
    this.selectedType.set(type);
    this.currentPage.set(1);
    this.loadReports();
  }

  protected onStatusChange(status: string): void {
    this.selectedStatus.set(status);
    this.currentPage.set(1);
    this.loadReports();
  }

  protected goToPage(page: number): void {
    if (page < 1 || page > this.totalPages() || page === this.currentPage()) {
      return;
    }
    this.currentPage.set(page);
    this.loadReports();
  }

  protected refreshReports(): void {
    this.loadReports();
    this.loadStatistics();
    this.showToast('Đã làm mới danh mục báo cáo và số liệu thống kê.', 'info');
  }

  protected downloadReport(report: ReportItem, format: 'PDF' | 'EXCEL'): void {
    const downloadKey = `${report.id}-${format}`;
    if (this.isDownloading() === downloadKey) {
      return;
    }

    this.isDownloading.set(downloadKey);
    const formatParam = format === 'PDF' ? 'pdf' : 'excel';
    const isFileGenerated = format === 'PDF' ? report.fileSizePdf != null : report.fileSizeExcel != null;

    // Step 1: If file hasn't been generated yet, trigger generate first
    if (!isFileGenerated) {
      this.showToast(`Đang tổng hợp & xuất bản tệp ${format} cho báo cáo ${report.code}...`, 'info');
      this.reportsApi.generateReport(report.id, formatParam).subscribe({
        next: () => {
          this.executeDownload(report, format, downloadKey);
        },
        error: (err) => {
          console.warn('Generate error, attempting direct download anyway:', err);
          this.executeDownload(report, format, downloadKey);
        },
      });
    } else {
      this.executeDownload(report, format, downloadKey);
    }
  }

  private executeDownload(report: ReportItem, format: 'PDF' | 'EXCEL', downloadKey: string): void {
    const formatParam = format === 'PDF' ? 'pdf' : 'excel';
    this.reportsApi.downloadReportFile(report.id, formatParam).subscribe({
      next: (blob) => {
        this.isDownloading.set(null);
        const extension = format === 'PDF' ? 'pdf' : 'xlsx';
        const filename = `${report.code}_${format}.${extension}`;

        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(blobUrl);

        this.showToast(`Tải xuống tệp ${format} (${filename}) thành công!`, 'success');
        // Refresh to update file sizes if newly generated
        this.loadReports();
      },
      error: (err) => {
        console.error(`Download ${format} failed:`, err);
        this.isDownloading.set(null);
        this.showToast(`Không thể tải tệp ${format} cho báo cáo ${report.code}.`, 'error');
      },
    });
  }

  protected openCreateModal(): void {
    this.newReportTitle.set('');
    this.newReportType.set('defect');
    this.newReportDescription.set('');
    this.targetCategory.set('line');

    if (this.powerLines().length > 0 && !this.selectedLineId()) {
      this.selectedLineId.set(this.powerLines()[0].id);
    }
    if (this.substations().length > 0 && !this.selectedSubstationId()) {
      this.selectedSubstationId.set(this.substations()[0].id);
    }

    this.isCreateModalOpen.set(true);
  }

  protected closeCreateModal(): void {
    if (this.isSubmitting()) return;
    this.isCreateModalOpen.set(false);
  }

  protected createReport(): void {
    const title = this.newReportTitle().trim();
    if (!title) {
      this.showToast('Vui lòng nhập tên tiêu đề báo cáo!', 'error');
      return;
    }

    this.isSubmitting.set(true);

    const isLine = this.targetCategory() === 'line';
    const request: ReportCreateRequest = {
      title,
      type: this.newReportType(),
      transmissionLineId: isLine ? this.selectedLineId() || undefined : undefined,
      substationId: !isLine ? this.selectedSubstationId() || undefined : undefined,
      description: this.newReportDescription().trim() || undefined,
    };

    this.reportsApi.createReport(request).subscribe({
      next: (created) => {
        this.isSubmitting.set(false);
        this.isCreateModalOpen.set(false);
        this.showToast(`Đã lập thành công báo cáo ${created.code}!`, 'success');
        this.currentPage.set(1);
        this.loadReports();
        this.loadStatistics();
      },
      error: (err) => {
        console.error('Failed to create report:', err);
        this.isSubmitting.set(false);
        this.showToast('Có lỗi xảy ra khi tạo báo cáo. Vui lòng thử lại!', 'error');
      },
    });
  }

  protected showToast(msg: string, type: 'success' | 'error' | 'info' = 'success'): void {
    this.toastMessage.set(msg);
    this.toastType.set(type);
    setTimeout(() => {
      if (this.toastMessage() === msg) {
        this.toastMessage.set(null);
      }
    }, 4000);
  }
}
