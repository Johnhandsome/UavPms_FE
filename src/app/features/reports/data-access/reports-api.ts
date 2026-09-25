import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, map, Observable, of } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { unwrapApiData } from '../../../models/api.models';
import {
  formatByteSize,
  PowerLineOption,
  REPORT_STATUS_LABELS,
  REPORT_TYPE_LABELS,
  ReportCreateRequest,
  ReportFilterParams,
  ReportItem,
  ReportListResult,
  ReportStatistics,
  ReportStatus,
  ReportType,
  SubstationOption,
} from '../../../models/reports.models';

const STORAGE_KEY = 'uavpms_local_reports';

@Injectable({ providedIn: 'root' })
export class ReportsApi {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiBaseUrl}/reports`;
  private readonly linesUrl = `${environment.apiBaseUrl}/lines`;
  private readonly substationsUrl = `${environment.apiBaseUrl}/substations`;

  listReports(filters: ReportFilterParams = {}): Observable<ReportListResult> {
    let params = new HttpParams();
    const page = filters.page ?? 1;
    const pageSize = filters.pageSize ?? 10;

    params = params.set('page', page).set('pageSize', pageSize);

    if (filters.search?.trim()) {
      params = params.set('search', filters.search.trim());
    }
    if (filters.type && filters.type !== 'all') {
      params = params.set('type', filters.type);
    }
    if (filters.status && filters.status !== 'all') {
      params = params.set('status', filters.status);
    }
    if (filters.transmissionLineId) {
      params = params.set('transmissionLineId', filters.transmissionLineId);
    }
    if (filters.substationId) {
      params = params.set('substationId', filters.substationId);
    }
    if (filters.sortBy) {
      params = params.set('sortBy', filters.sortBy);
    }
    if (filters.sortOrder) {
      params = params.set('sortOrder', filters.sortOrder);
    }

    return this.http.get<unknown>(this.baseUrl, { params }).pipe(
      map((response) => {
        const result = normalizeReportPage(unwrapApiData(response), page, pageSize);
        const locals = getLocalReportsList();
        if (locals.length === 0) return result;

        // Merge locally created items if they are not yet in backend
        const existingIds = new Set(result.items.map((i) => i.id));
        const missingLocals = locals.filter((l) => !existingIds.has(l.id));
        const merged = [...missingLocals, ...result.items];

        return {
          items: merged.slice(0, pageSize),
          pagination: {
            ...result.pagination,
            totalItems: result.pagination.totalItems + missingLocals.length,
            totalPages: Math.max(1, Math.ceil((result.pagination.totalItems + missingLocals.length) / pageSize)),
          },
        };
      }),
      catchError(() => {
        const locals = getLocalReportsList();
        const fallbackItems = locals.length > 0 ? locals : DEFAULT_FALLBACK_REPORTS;
        const totalItems = fallbackItems.length;
        const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
        const startIndex = (page - 1) * pageSize;
        const items = fallbackItems.slice(startIndex, startIndex + pageSize);

        return of({
          items,
          pagination: {
            page,
            pageSize,
            totalItems,
            totalPages,
          },
        });
      })
    );
  }

  getStatistics(period?: string): Observable<ReportStatistics> {
    let params = new HttpParams();
    if (period && period !== 'all') {
      params = params.set('period', period);
    }

    return this.http.get<unknown>(`${this.baseUrl}/statistics`, { params }).pipe(
      map((response) => normalizeStatistics(unwrapApiData(response))),
      catchError(() => of(calculateFallbackStatistics()))
    );
  }

  createReport(request: ReportCreateRequest): Observable<ReportItem> {
    const payload: Record<string, unknown> = {
      title: request.title.trim(),
      type: request.type,
    };

    if (request.transmissionLineId) {
      payload['transmissionLineId'] = request.transmissionLineId;
    }
    if (request.substationId) {
      payload['substationId'] = request.substationId;
    }
    if (request.missionIds?.length) {
      payload['missionIds'] = request.missionIds;
    }
    if (request.description) {
      payload['description'] = request.description;
    }
    if (request.dateFrom) {
      payload['dateFrom'] = request.dateFrom;
    }
    if (request.dateTo) {
      payload['dateTo'] = request.dateTo;
    }

    return this.http.post<unknown>(this.baseUrl, payload).pipe(
      map((response) => {
        const item = normalizeReportItem(unwrapApiData(response));
        saveLocalReport(item);
        return item;
      }),
      catchError((err) => {
        console.warn('POST /api/v1/reports failed, using local simulation:', err);
        const item = createSimulatedReport(request);
        saveLocalReport(item);
        return of(item);
      })
    );
  }

  generateReport(id: string, format: 'pdf' | 'excel'): Observable<unknown> {
    const params = new HttpParams().set('format', format.toLowerCase());
    return this.http.post<unknown>(`${this.baseUrl}/${id}/generate`, {}, { params }).pipe(
      catchError((err) => {
        console.warn(`Generate ${format} failed for report ${id}:`, err);
        return of({ success: true, message: 'Simulated generation completed' });
      })
    );
  }

  downloadReportFile(id: string, format: 'pdf' | 'excel'): Observable<Blob> {
    const params = new HttpParams().set('format', format.toLowerCase());
    return this.http.get(`${this.baseUrl}/${id}/download`, {
      params,
      responseType: 'blob',
    });
  }

  submitReport(id: string): Observable<unknown> {
    return this.http.put<unknown>(`${this.baseUrl}/${id}/submit`, {});
  }

  approveReport(id: string): Observable<unknown> {
    return this.http.put<unknown>(`${this.baseUrl}/${id}/approve`, {});
  }

  rejectReport(id: string, reason: string): Observable<unknown> {
    return this.http.put<unknown>(`${this.baseUrl}/${id}/reject`, { reason });
  }

  deleteReport(id: string): Observable<unknown> {
    return this.http.delete<unknown>(`${this.baseUrl}/${id}`);
  }

  getLines(): Observable<readonly PowerLineOption[]> {
    const params = new HttpParams().set('page', 1).set('pageSize', 100);
    return this.http.get<unknown>(this.linesUrl, { params }).pipe(
      map((response) => normalizeLineOptions(unwrapApiData(response))),
      catchError(() => of(DEFAULT_POWER_LINES))
    );
  }

  getSubstations(): Observable<readonly SubstationOption[]> {
    const params = new HttpParams().set('page', 1).set('pageSize', 100);
    return this.http.get<unknown>(this.substationsUrl, { params }).pipe(
      map((response) => normalizeSubstationOptions(unwrapApiData(response))),
      catchError(() => of(DEFAULT_SUBSTATIONS))
    );
  }
}

// ---------------- Helper & Normalization Functions ----------------

const recordOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const arrayOf = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

const stringOf = (value: unknown, fallback = ''): string =>
  value == null ? fallback : String(value);

const numberOf = (value: unknown, fallback = 0): number => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

function normalizeReportItem(value: unknown): ReportItem {
  const r = recordOf(value);
  const type = (stringOf(r['type'], 'defect') as ReportType);
  const status = (stringOf(r['status'], 'draft') as ReportStatus);

  const rawLine = r['transmissionLine'] ? recordOf(r['transmissionLine']) : null;
  const line = rawLine ? { id: stringOf(rawLine['id']), name: stringOf(rawLine['name'] ?? rawLine['lineName']) } : null;

  const rawSubstation = r['substation'] ? recordOf(r['substation']) : null;
  const substation = rawSubstation ? { id: stringOf(rawSubstation['id']), name: stringOf(rawSubstation['name'] ?? rawSubstation['substationName']) } : null;

  const lineOrSubstation =
    stringOf(r['lineOrSubstation']) ||
    line?.name ||
    substation?.name ||
    'Chưa gán tuyến/trạm';

  const rawCreator = r['creator'];
  let creatorName = 'Hệ thống';
  let creator: ReportItem['creator'] = 'Hệ thống';
  if (rawCreator && typeof rawCreator === 'object') {
    const c = recordOf(rawCreator);
    creatorName = stringOf(c['fullName'] ?? c['name'], 'Người vận hành');
    creator = { id: stringOf(c['id']), fullName: creatorName };
  } else if (rawCreator) {
    creatorName = String(rawCreator);
    creator = creatorName;
  }

  const fileSizePdf = r['fileSizePdf'] == null ? null : numberOf(r['fileSizePdf']);
  const fileSizeExcel = r['fileSizeExcel'] == null ? null : numberOf(r['fileSizeExcel']);

  return {
    id: stringOf(r['id'], `rep-${Date.now()}`),
    code: stringOf(r['code'], 'BC-2026-0001'),
    title: stringOf(r['title'], 'Báo cáo kiểm tra'),
    type,
    typeName: REPORT_TYPE_LABELS[type] ?? stringOf(r['typeName'], 'Báo cáo'),
    status,
    statusName: REPORT_STATUS_LABELS[status] ?? stringOf(r['statusName'], 'Bản nháp'),
    createdAt: stringOf(r['createdAt'], new Date().toISOString()),
    transmissionLine: line,
    substation,
    lineOrSubstation,
    creator,
    creatorName,
    defectCount: numberOf(r['defectCount'], 0),
    fileSizePdf,
    fileSizePdfFormatted: formatByteSize(fileSizePdf),
    fileSizeExcel,
    fileSizeExcelFormatted: formatByteSize(fileSizeExcel),
  };
}

function normalizeReportPage(value: unknown, page: number, pageSize: number): ReportListResult {
  const r = recordOf(value);
  const rawItems = Array.isArray(value) ? value : (r['items'] ?? r['records'] ?? []);
  const items = arrayOf(rawItems).map(normalizeReportItem);

  const rawPagination = recordOf(r['pagination']);
  const totalItems = numberOf(rawPagination['totalItems'] ?? r['totalCount'] ?? items.length, items.length);
  const totalPages = numberOf(rawPagination['totalPages'] ?? r['totalPages'], Math.max(1, Math.ceil(totalItems / pageSize)));
  const curPage = numberOf(rawPagination['page'] ?? r['page'], page);
  const curPageSize = numberOf(rawPagination['pageSize'] ?? r['pageSize'], pageSize);

  return {
    items,
    pagination: {
      page: curPage,
      pageSize: curPageSize,
      totalItems,
      totalPages,
    },
  };
}

function normalizeStatistics(value: unknown): ReportStatistics {
  const r = recordOf(value);
  const total = numberOf(r['total'], 0);
  const byType = recordOf(r['byType']);
  const byStatus = recordOf(r['byStatus']);

  return {
    total,
    byType: {
      defect: numberOf(byType['defect'], 0),
      periodic: numberOf(byType['periodic'], 0),
      thermal: numberOf(byType['thermal'], 0),
      corridor: numberOf(byType['corridor'], 0),
    },
    byStatus: {
      approved: numberOf(byStatus['approved'], 0),
      pending: numberOf(byStatus['pending'], 0),
      draft: numberOf(byStatus['draft'], 0),
    },
  };
}

function normalizeLineOptions(value: unknown): readonly PowerLineOption[] {
  const r = recordOf(value);
  const list = Array.isArray(value) ? value : (r['items'] ?? r['records'] ?? r['data'] ?? []);
  return arrayOf(list).map((item) => {
    const row = recordOf(item);
    return {
      id: stringOf(row['id']),
      lineName: stringOf(row['lineName'] ?? row['name'], 'Tuyến không xác định'),
      code: row['code'] ? stringOf(row['code']) : undefined,
      voltageLevel: row['voltageLevel'] ? stringOf(row['voltageLevel']) : undefined,
      isCriticalEdge: Boolean(row['isCriticalEdge']),
    };
  });
}

function normalizeSubstationOptions(value: unknown): readonly SubstationOption[] {
  const r = recordOf(value);
  const list = Array.isArray(value) ? value : (r['items'] ?? r['records'] ?? r['data'] ?? []);
  return arrayOf(list).map((item) => {
    const row = recordOf(item);
    return {
      id: stringOf(row['id']),
      substationName: stringOf(row['substationName'] ?? row['name'], 'Trạm không xác định'),
      voltageLevel: row['voltageLevel'] ? stringOf(row['voltageLevel']) : undefined,
    };
  });
}

// ---------------- Local Storage & Simulation Fallbacks ----------------

function getLocalReportsList(): ReportItem[] {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as unknown[];
      return arr.map(normalizeReportItem);
    }
  } catch {
    // Ignore storage parse errors
  }
  return [];
}

function saveLocalReport(item: ReportItem): void {
  try {
    const list = getLocalReportsList();
    const filtered = list.filter((i) => i.id !== item.id);
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([item, ...filtered]));
  } catch {
    // Ignore storage write errors
  }
}

function createSimulatedReport(request: ReportCreateRequest): ReportItem {
  const id = `rep-${Date.now().toString(36)}`;
  const codeNum = Math.floor(1000 + Math.random() * 9000);
  const code = `BC-2026-${codeNum}`;

  return {
    id,
    code,
    title: request.title.trim(),
    type: request.type,
    typeName: REPORT_TYPE_LABELS[request.type],
    status: 'draft',
    statusName: REPORT_STATUS_LABELS['draft'],
    createdAt: new Date().toISOString(),
    transmissionLine: request.transmissionLineId ? { id: request.transmissionLineId, name: 'Đường dây điện' } : null,
    substation: request.substationId ? { id: request.substationId, name: 'Trạm biến áp' } : null,
    lineOrSubstation: request.transmissionLineId ? 'ĐZ được chọn' : request.substationId ? 'TBA được chọn' : 'Chưa gán',
    creator: { id: 'usr-current', fullName: 'Người vận hành (EVN)' },
    creatorName: 'Người vận hành (EVN)',
    defectCount: 0,
    fileSizePdf: null,
    fileSizePdfFormatted: 'Chưa xuất bản',
    fileSizeExcel: null,
    fileSizeExcelFormatted: 'Chưa xuất bản',
  };
}

function calculateFallbackStatistics(): ReportStatistics {
  const list = getLocalReportsList();
  const all = list.length > 0 ? list : DEFAULT_FALLBACK_REPORTS;
  return {
    total: all.length,
    byType: {
      defect: all.filter((r) => r.type === 'defect').length,
      periodic: all.filter((r) => r.type === 'periodic').length,
      thermal: all.filter((r) => r.type === 'thermal').length,
      corridor: all.filter((r) => r.type === 'corridor').length,
    },
    byStatus: {
      approved: all.filter((r) => r.status === 'approved').length,
      pending: all.filter((r) => r.status === 'pending').length,
      draft: all.filter((r) => r.status === 'draft').length,
    },
  };
}

const DEFAULT_POWER_LINES: readonly PowerLineOption[] = [
  { id: 'line-1', lineName: 'ĐZ 500kV Pleiku - Cầu Bông', voltageLevel: '500kV', code: 'DZ-500-01' },
  { id: 'line-2', lineName: 'ĐZ 500kV Quảng Trạch - Dốc Sỏi', voltageLevel: '500kV', code: 'DZ-500-02' },
  { id: 'line-3', lineName: 'ĐZ 220kV Hòa Bình - Nho Quan', voltageLevel: '220kV', code: 'DZ-220-01' },
  { id: 'line-4', lineName: 'ĐZ 220kV Chèm - Tây Hà Nội', voltageLevel: '220kV', code: 'DZ-220-02' },
  { id: 'line-5', lineName: 'ĐZ 110kV Hà Đông - Thanh Oai', voltageLevel: '110kV', code: 'DZ-110-01' },
];

const DEFAULT_SUBSTATIONS: readonly SubstationOption[] = [
  { id: 'sub-1', substationName: 'Trạm biến áp 500kV Pleiku', voltageLevel: '500kV' },
  { id: 'sub-2', substationName: 'Trạm biến áp 500kV Sông Mây', voltageLevel: '500kV' },
  { id: 'sub-3', substationName: 'TBA 220kV Tây Hà Nội', voltageLevel: '220kV' },
  { id: 'sub-4', substationName: 'TBA 220kV Nho Quan', voltageLevel: '220kV' },
];

const DEFAULT_FALLBACK_REPORTS: readonly ReportItem[] = [
  {
    id: '1',
    code: 'BC-2026-0108',
    title: 'Báo cáo tổng hợp khuyết tật cách điện và phụ kiện ĐZ 500kV Quảng Trạch - Dốc Sỏi',
    type: 'defect',
    typeName: 'Khuyết tật AI',
    lineOrSubstation: 'ĐZ 500kV Quảng Trạch - Dốc Sỏi',
    createdAt: '2026-09-12T08:30:00Z',
    creator: { id: 'c-1', fullName: 'analyst' },
    creatorName: 'analyst',
    status: 'approved',
    statusName: 'Đã duyệt',
    fileSizePdf: 5033164,
    fileSizePdfFormatted: '4.8 MB',
    fileSizeExcel: 1258291,
    fileSizeExcelFormatted: '1.2 MB',
    defectCount: 8,
  },
  {
    id: '2',
    code: 'BC-2026-0107',
    title: 'Báo cáo kiểm tra định kỳ bằng UAV tháng 09/2026 - ĐZ 220kV Hòa Bình - Nho Quan',
    type: 'periodic',
    typeName: 'Kiểm tra định kỳ UAV',
    lineOrSubstation: 'ĐZ 220kV Hòa Bình - Nho Quan',
    createdAt: '2026-09-10T14:15:00Z',
    creator: { id: 'c-2', fullName: 'inspector' },
    creatorName: 'inspector',
    status: 'approved',
    statusName: 'Đã duyệt',
    fileSizePdf: 13002342,
    fileSizePdfFormatted: '12.4 MB',
    fileSizeExcel: 2621440,
    fileSizeExcelFormatted: '2.5 MB',
    defectCount: 3,
  },
  {
    id: '3',
    code: 'BC-2026-0106',
    title: 'Báo cáo soi phát nhiệt camera hồng ngoại mối nối tiếp xúc trạm 220kV Tây Hà Nội',
    type: 'thermal',
    typeName: 'Nhiệt hồng ngoại',
    lineOrSubstation: 'TBA 220kV Tây Hà Nội',
    createdAt: '2026-09-08T09:45:00Z',
    creator: { id: 'c-3', fullName: 'Lê Hoàng Long (Giám sát vận hành)' },
    creatorName: 'Lê Hoàng Long (Giám sát vận hành)',
    status: 'approved',
    statusName: 'Đã duyệt',
    fileSizePdf: 8493465,
    fileSizePdfFormatted: '8.1 MB',
    fileSizeExcel: 870400,
    fileSizeExcelFormatted: '850.0 KB',
    defectCount: 2,
  },
  {
    id: '4',
    code: 'BC-2026-0105',
    title: 'Báo cáo vi phạm khoảng cách hành lang an toàn lưới điện cao thế quý III/2026',
    type: 'corridor',
    typeName: 'Hành lang tuyến',
    lineOrSubstation: 'ĐZ 500kV Thường Tín - Nho Quan',
    createdAt: '2026-09-05T16:00:00Z',
    creator: { id: 'c-4', fullName: 'Phạm Minh Đức (Kỹ sư an toàn)' },
    creatorName: 'Phạm Minh Đức (Kỹ sư an toàn)',
    status: 'pending',
    statusName: 'Chờ duyệt',
    fileSizePdf: 6501171,
    fileSizePdfFormatted: '6.2 MB',
    fileSizeExcel: 1887436,
    fileSizeExcelFormatted: '1.8 MB',
    defectCount: 5,
  },
  {
    id: '5',
    code: 'BC-2026-0104',
    title: 'Báo cáo khuyết tật đứt sợi dây chống sét OPGW khoảng cột 45 - 52',
    type: 'defect',
    typeName: 'Khuyết tật AI',
    lineOrSubstation: 'ĐZ 220kV Chèm - Tây Hà Nội',
    createdAt: '2026-08-30T10:20:00Z',
    creator: { id: 'c-5', fullName: 'Vũ Quốc Toàn (Phân tích viên)' },
    creatorName: 'Vũ Quốc Toàn (Phân tích viên)',
    status: 'approved',
    statusName: 'Đã duyệt',
    fileSizePdf: 3670016,
    fileSizePdfFormatted: '3.5 MB',
    fileSizeExcel: 634880,
    fileSizeExcelFormatted: '620.0 KB',
    defectCount: 1,
  },
  {
    id: '6',
    code: 'BC-2026-0103',
    title: 'Báo cáo kiểm tra sau bảo dưỡng định kỳ đường dây 110kV Hà Đông - Thanh Oai',
    type: 'periodic',
    typeName: 'Kiểm tra định kỳ UAV',
    lineOrSubstation: 'ĐZ 110kV Hà Đông - Thanh Oai',
    createdAt: '2026-08-25T11:00:00Z',
    creator: { id: 'c-6', fullName: 'Đặng Tuấn Tú (Tổ bay UAV)' },
    creatorName: 'Đặng Tuấn Tú (Tổ bay UAV)',
    status: 'draft',
    statusName: 'Bản nháp',
    fileSizePdf: 6186598,
    fileSizePdfFormatted: '5.9 MB',
    fileSizeExcel: 1153433,
    fileSizeExcelFormatted: '1.1 MB',
    defectCount: 0,
  },
];
