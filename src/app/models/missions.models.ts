export type MissionStatus = 'Pending' | 'Executing' | 'Completed' | 'Failed' | 'Cancelled' | string;

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
  readonly scheduledAt?: string;
  readonly targets: readonly MissionTarget[];
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
  readonly inspectorId: string;
  readonly droneId: string;
  readonly targetAssetIds: readonly string[];
  readonly routeData?: string;
}

export interface MissionTarget {
  readonly assetId: string;
  readonly assetCode: string;
  readonly assetName: string;
  readonly towerCode?: string;
  readonly sequence: number | null;
  readonly inspectionStatus: string;
  readonly latitude?: number;
  readonly longitude?: number;
}

export interface InspectionSettings {
  readonly inspectionTypes: readonly string[];
  readonly checklist: string;
}
