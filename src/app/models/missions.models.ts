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
  readonly type: 'DISPATCH' | 'CONFIRM' | 'POSTPONE' | 'SUSPEND' | 'RESUME' | 'CANCEL' | 'REMINDER' | 'MESSAGE';
  readonly content: string;
  readonly timestamp: string;
  readonly metadata?: Record<string, unknown>;
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
  readonly name: string;
  readonly description: string;
  readonly scheduledAt: string;
  readonly plannedEnd: string;
  readonly regionId: string;
  readonly missionType: 'AD_HOC' | 'SCHEDULED';
  readonly triggerReason?: string;
  readonly scheduleId?: string;
  readonly inspectorId: string;
  readonly droneId: string;
  readonly targetAssetIds: readonly string[];
  readonly boundaryWkt: string;
  readonly routeData?: string;
  readonly confirmationDeadline?: string;
  readonly managerInstructions?: string;
  readonly sourceAssessmentId?: string;
  readonly priority?: string;
}

export interface MissionAssignment {
  readonly id: string;
  readonly userId: string;
  readonly userName: string;
  readonly assignmentRole: string;
  readonly status: string;
  readonly checkedInAt?: string | null;
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
