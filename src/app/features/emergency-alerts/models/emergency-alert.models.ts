export type AlertSeverity = 'Critical' | 'High' | 'Medium' | 'Low';
export type AlertStatus = 'Active' | 'Confirmed' | 'Dismissed' | 'Escalated';

export interface AlertBoundingBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly isNormalized?: boolean;
}

export interface AlertReviewLog {
  readonly reviewedBy: string;
  readonly reviewerRole: string;
  readonly reviewedAt: string;
  readonly decision: 'Confirmed' | 'Dismissed' | 'Escalated';
  readonly notes?: string;
  readonly escalatedToUserId?: string;
  readonly escalatedToUserName?: string;
  readonly escalationReason?: string;
}

export interface EmergencyAlertItem {
  readonly id: string;
  readonly title: string;
  readonly alertType: string;
  readonly categoryCode: string;
  readonly severity: AlertSeverity;
  readonly status: AlertStatus;
  readonly detectedAt: string;
  readonly assetCode: string;
  readonly assetName: string;
  readonly towerCode: string;
  readonly lineName: string;
  readonly substationName?: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly imageUrl: string;
  readonly boundingBox?: AlertBoundingBox;
  readonly confidenceScore: number;
  readonly aiModelName: string;
  readonly droneId: string;
  readonly missionCode: string;
  readonly description?: string;
  readonly reviewInfo?: AlertReviewLog;
}

export interface ReviewAlertPayload {
  readonly status: 'Confirmed' | 'Dismissed';
  readonly notes: string;
}

export interface EscalateAlertPayload {
  readonly escalatedToUserId: string;
  readonly reason: string;
}

export interface EscalationManagerOption {
  readonly id: string;
  readonly fullName: string;
  readonly email: string;
  readonly role: string;
  readonly department: string;
  readonly phone?: string;
}
