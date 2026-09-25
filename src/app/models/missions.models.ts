export type MissionStatus =
  | 'Draft'
  | 'PENDING_CONFIRMATION'
  | 'CONFIRMED'
  | 'Assigned'
  | 'Preparing'
  | 'Ready'
  | 'InProgress'
  | 'POSTPONED'
  | 'SUSPENDED'
  | 'Completed'
  | 'Cancelled'
  | string;

export interface MissionCommunicationLog {
  readonly id: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly senderRole: 'MANAGER' | 'INSPECTOR' | 'SYSTEM';
  readonly type: 'DISPATCH' | 'CONFIRM' | 'POSTPONE' | 'SUSPEND' | 'RESUME' | 'CANCEL' | 'REMINDER' | 'MESSAGE' | 'START' | 'COMPLETE';
  readonly content: string;
  readonly timestamp: string;
  readonly metadata?: Record<string, unknown>;
}

export type MissionOperationalRole = 'INSPECTOR' | 'ANALYST' | 'TECHNICIAN' | string;

export type AssignmentResponseStatus = 'PENDING' | 'ACCEPTED' | 'POSTPONED' | 'REPLACED' | 'CANCELLED' | string;

export interface MissionMemberAssignmentItem {
  readonly userId: string;
  readonly role: MissionOperationalRole;
  readonly isRequired?: boolean;
}

export interface MissionAssignmentsOverview {
  readonly missionId: string;
  readonly totalRequiredCount: number;
  readonly confirmedCount: number;
  readonly allConfirmed: boolean;
  readonly confirmationDeadline?: string | null;
  readonly assignments: readonly MissionAssignment[];
}

export interface MissionBackendDetection {
  readonly id: string;
  readonly missionId: string;
  readonly mediaId?: string;
  readonly title: string;
  readonly confidence: number;
  readonly categoryCode?: string;
  readonly severityWeight?: number;
  readonly isEmergency?: boolean;
  readonly status: 'Pending' | 'Approved' | 'Rejected' | string;
  readonly boundingBox?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly timestampSeconds?: number | null;
  readonly timestampLabel?: string;
  readonly frameIndex?: number | null;
  readonly imageUrl?: string;
  readonly sourceUrl?: string;
  readonly assetId?: string;
  readonly tower?: string;
  readonly gps?: string;
  readonly description?: string;
  readonly detectedAt?: string;
  readonly reviewedByUserId?: string | null;
  readonly reviewedAt?: string | null;
  readonly reviewNotes?: string | null;
}

export interface MissionBackendMaintenanceTask {
  readonly id: string;
  readonly missionId: string;
  readonly detectionId?: string;
  readonly title: string;
  readonly priority: 'Urgent' | 'High' | 'Medium' | 'Low' | string;
  readonly towerCode?: string;
  readonly assetCode?: string;
  readonly defectDescription?: string;
  readonly suggestedAction?: string;
  readonly status: 'Pending' | 'Approved' | 'InProgress' | 'Completed' | string;
  readonly assignedTeam?: string;
  readonly createdAt?: string;
}

export interface MissionBackendActivity {
  readonly id: string;
  readonly missionId: string;
  readonly senderUserId?: string;
  readonly senderName: string;
  readonly senderRole: 'MANAGER' | 'INSPECTOR' | 'ANALYST' | 'TECHNICIAN' | 'SYSTEM' | string;
  readonly content: string;
  readonly timestamp: string;
}

export interface MissionAssignment {
  readonly id: string;
  readonly missionId?: string;
  readonly userId: string;
  readonly userName: string;
  readonly userFullName?: string;
  readonly assignmentRole: MissionOperationalRole;
  readonly status: string; // 'Active' | 'Unavailable' | 'Revoked' | string
  readonly responseStatus?: AssignmentResponseStatus;
  readonly isRequired?: boolean;
  readonly assignedAt?: string;
  readonly respondedAt?: string | null;
  readonly responseReason?: string | null;
  readonly checkedInAt?: string | null;
}

export interface Mission {
  readonly id: string;
  readonly missionCode: string;
  readonly title: string;
  readonly routeData: string;
  readonly assignedToUserId: string;
  readonly assignedToUsername: string;
  readonly droneCode: string;
  readonly status: MissionStatus;
  readonly description: string;
  readonly managerId: string;
  readonly managerUsername: string;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  readonly targets: readonly MissionTarget[];
  readonly scheduledStartAt?: string | null;
  readonly regionId?: string;
  readonly regionName?: string;
  readonly missionType?: 'Scheduled' | 'AdHoc' | string;
  readonly triggerReason?: string | null;
  readonly plannedStart?: string | null;
  readonly plannedEnd?: string | null;
  readonly actualStart?: string | null;
  readonly actualCompleted?: string | null;
  readonly boundaryWkt?: string | null;
  readonly team?: readonly MissionAssignment[];
  readonly confirmationDeadline?: string | null;
  readonly managerInstructions?: string | null;
  readonly postponeReason?: string | null;
  readonly suspendedReason?: string | null;
  readonly cancellationReason?: string | null;
  readonly sourceAssessmentId?: string | null;
  readonly priority?: 'Urgent' | 'High' | 'Medium' | 'Normal' | 'Low' | string;
  readonly communicationLogs?: readonly MissionCommunicationLog[];
  // Multi-role confirmation progress properties
  readonly confirmedAt?: string | null;
  readonly confirmedCount?: number;
  readonly totalRequiredCount?: number;
  readonly confirmationProgress?: number | string;
  readonly allConfirmed?: boolean;
  readonly pendingRoles?: readonly string[];
  readonly requiresReassignment?: boolean;
}

export interface MissionPage {
  readonly items: readonly Mission[];
  readonly page: number;
  readonly pageSize: number;
  readonly totalCount: number;
  readonly totalPages: number;
}

export interface MissionMutationRequest {
  readonly title?: string;
  readonly routeData?: string;
  readonly assignedToUserId: string;
  readonly droneCode?: string;
  readonly status?: string;
  readonly description?: string;
}

export interface MissionCreateRequest {
  readonly name?: string;
  readonly title?: string;
  readonly description: string;
  readonly scheduledAt?: string;
  readonly plannedStart?: string;
  readonly plannedEnd: string;
  readonly regionId?: string;
  readonly missionType?: 'AD_HOC' | 'SCHEDULED' | string;
  readonly triggerReason?: string;
  readonly scheduleId?: string;
  readonly inspectorId?: string;
  readonly droneId?: string;
  readonly droneIds?: readonly string[];
  readonly targetAssetIds?: readonly string[];
  readonly boundaryWkt?: string;
  readonly routeData?: string;
  readonly confirmationDeadline?: string;
  readonly managerInstructions?: string;
  readonly sourceAssessmentId?: string;
  readonly assessmentId?: string;
  readonly priority?: string;
  readonly assignments?: readonly MissionMemberAssignmentItem[];
  readonly personnel?: readonly MissionMemberAssignmentItem[];
  readonly idempotencyKey?: string;
}

export interface MissionTarget {
  readonly assetId: string;
  readonly assetCode: string;
  readonly assetName: string;
  readonly towerCode?: string;
  readonly assetType?: string;
  readonly sequence: number | null;
  readonly inspectionStatus: string;
  readonly latitude?: number;
  readonly longitude?: number;
}

export interface InspectionSettings {
  readonly inspectionTypes: readonly string[];
  readonly checklist: string;
}
