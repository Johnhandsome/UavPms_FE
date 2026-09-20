export type ReportType = 'defect' | 'periodic' | 'thermal' | 'corridor';
export type ReportStatus = 'draft' | 'pending' | 'approved';

export interface ReportTransmissionLine {
  readonly id: string;
  readonly name: string;
}

export interface ReportSubstation {
  readonly id: string;
  readonly name: string;
}

export interface ReportCreator {
  readonly id: string;
  readonly fullName: string;
}

export interface ReportItem {
  readonly id: string;
  readonly code: string;
  readonly title: string;
  readonly type: ReportType;
  readonly typeName: string;
  readonly status: ReportStatus;
  readonly statusName: string;
  readonly createdAt: string;
  readonly transmissionLine?: ReportTransmissionLine | null;
  readonly substation?: ReportSubstation | null;
  readonly lineOrSubstation: string;
  readonly creator: ReportCreator | string;
  readonly creatorName: string;
  readonly defectCount: number;
  readonly fileSizePdf: number | null;
  readonly fileSizePdfFormatted: string;
  readonly fileSizeExcel: number | null;
  readonly fileSizeExcelFormatted: string;
}

export interface ReportStatistics {
  readonly total: number;
  readonly byType: {
    readonly defect: number;
    readonly periodic: number;
    readonly thermal: number;
    readonly corridor: number;
  };
  readonly byStatus: {
    readonly approved: number;
    readonly pending: number;
    readonly draft: number;
  };
}

export interface ReportFilterParams {
  readonly search?: string;
  readonly type?: string;
  readonly status?: string;
  readonly transmissionLineId?: string;
  readonly substationId?: string;
  readonly sortBy?: 'createdAt' | 'code' | 'title' | 'type' | 'status';
  readonly sortOrder?: 'desc' | 'asc';
  readonly page?: number;
  readonly pageSize?: number;
}

export interface ReportPagination {
  readonly page: number;
  readonly pageSize: number;
  readonly totalItems: number;
  readonly totalPages: number;
}

export interface ReportListResult {
  readonly items: readonly ReportItem[];
  readonly pagination: ReportPagination;
}

export interface ReportCreateRequest {
  readonly title: string;
  readonly type: ReportType;
  readonly transmissionLineId?: string | null;
  readonly substationId?: string | null;
  readonly missionIds?: readonly string[];
  readonly description?: string;
  readonly dateFrom?: string;
  readonly dateTo?: string;
}

export interface PowerLineOption {
  readonly id: string;
  readonly lineName: string;
  readonly code?: string;
  readonly voltageLevel?: string;
  readonly isCriticalEdge?: boolean;
}

export interface SubstationOption {
  readonly id: string;
  readonly substationName: string;
  readonly voltageLevel?: string;
}

export const REPORT_TYPE_LABELS: Record<ReportType, string> = {
  defect: 'Khuyết tật AI',
  periodic: 'Kiểm tra định kỳ UAV',
  thermal: 'Nhiệt hồng ngoại',
  corridor: 'Hành lang tuyến',
};

export const REPORT_STATUS_LABELS: Record<ReportStatus, string> = {
  approved: 'Đã duyệt',
  pending: 'Chờ duyệt',
  draft: 'Bản nháp',
};

export function formatByteSize(bytes: number | null | undefined): string {
  if (bytes == null || bytes <= 0 || isNaN(bytes)) {
    return 'Chưa xuất bản';
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kb = bytes / 1024;
  if (kb < 1024) {
    return `${kb.toFixed(1)} KB`;
  }
  const mb = kb / 1024;
  if (mb < 1024) {
    return `${mb.toFixed(1)} MB`;
  }
  const gb = mb / 1024;
  return `${gb.toFixed(2)} GB`;
}
