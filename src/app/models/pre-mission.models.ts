export type AssessmentStatus =
  | 'DRAFT'
  | 'EVALUATING'
  | 'READY'
  | 'NOT_READY'
  | 'EXPIRED'
  | 'COMPLETED'
  | 'CANCELLED'
  | string;

export interface ReadinessCheck {
  readonly status: string;
  readonly reason?: string | null;
  readonly evaluatedAt?: string | null;
}

export interface SiteCheckItem {
  readonly code: string;
  readonly name: string;
  readonly status: 'PASS' | 'WARNING' | 'FAIL';
  readonly details: string;
  readonly severity?: 'low' | 'medium' | 'high';
}

export interface PersonnelCandidate {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly region?: string;
  readonly availability: string;
  readonly eligibility: string;
  readonly conflict?: string | null;
  readonly reason?: string | null;
}

export interface UavCandidate {
  readonly id: string;
  readonly code: string;
  readonly name?: string;
  readonly operationalStatus: string;
  readonly technicalHealth: string;
  readonly lastInspection?: string | null;
  readonly validUntil?: string | null;
  readonly eligibility: string;
  readonly conflict?: string | null;
}

export interface TechnicalMetric {
  readonly subsystem: string;
  readonly metric: string;
  readonly value: string | number;
  readonly unit?: string | null;
  readonly required?: string | boolean | null;
  readonly severity?: string | null;
  readonly passed?: boolean | null;
}

export interface SubsystemHealth {
  readonly id: string;
  readonly name: string;
  readonly status: 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'UNKNOWN';
  readonly description?: string;
}

export interface DroneTechnicalInspectionResult {
  readonly droneId: string;
  readonly droneCode: string;
  readonly connectionStatus: 'CONNECTED' | 'DISCONNECTED' | 'CONNECTING';
  readonly fcTarget?: string;
  readonly firmwareVersion?: string;
  readonly inspectionSource: 'CLI' | 'MSP' | 'TELEMETRY' | 'BIST';
  readonly inspectedAt: string;
  readonly validUntil?: string | null;
  readonly overallHealth: 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'UNKNOWN';
  readonly eligibility: 'ELIGIBLE' | 'NOT_ELIGIBLE';
  readonly subsystems: readonly SubsystemHealth[];
  readonly metrics: readonly TechnicalMetric[];
}

export interface PreMissionAssessment {
  readonly id: string;
  readonly assessmentCode: string;
  readonly regionId?: string;
  readonly regionName: string;
  readonly lineId?: string | null;
  readonly lineName?: string | null;
  readonly assetCount: number;
  readonly plannedStart: string;
  readonly plannedEnd: string;
  readonly site: ReadinessCheck;
  readonly personnel: ReadinessCheck;
  readonly uav: ReadinessCheck;
  readonly technical: ReadinessCheck;
  readonly status: AssessmentStatus;
  readonly validUntil?: string | null;
  readonly createdBy?: string | null;
  readonly updatedAt?: string | null;
  readonly consumedMissionId?: string | null;
  readonly personnelCandidates: readonly PersonnelCandidate[];
  readonly uavCandidates: readonly UavCandidate[];
  readonly technicalMetrics: readonly TechnicalMetric[];
  readonly siteChecks?: readonly SiteCheckItem[];
  readonly droneInspection?: DroneTechnicalInspectionResult | null;
  readonly scopeAssetIds: readonly string[];
  readonly scopeGeometry?: unknown;
}

export interface AssessmentPage {
  readonly items: readonly PreMissionAssessment[];
  readonly page: number;
  readonly pageSize: number;
  readonly totalCount: number;
  readonly totalPages: number;
}

export interface AssessmentFilterOptions {
  page?: number;
  pageSize?: number;
  status?: string;
  regionId?: string;
  lineName?: string;
  plannedDate?: string;
  search?: string;
}

export interface AssessmentCreateRequest {
  readonly regionId: string;
  readonly lineName?: string;
  readonly scopeAssetIds: readonly string[];
  readonly plannedStart: string;
  readonly plannedEnd: string;
  readonly scopeGeometry?: unknown;
}
