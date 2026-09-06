import { Routes } from '@angular/router';
import { authGuard } from './core/auth/auth-guard';
import { guestGuard } from './core/auth/guest-guard';
import { roleGuard } from './core/auth/role-guard';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  { path: 'login', canActivate: [guestGuard], loadComponent: () => import('./features/auth/pages/login/login').then((m) => m.Login), title: 'Sign in | UAV-PMS' },
  { path: 'forgot-password', canActivate: [guestGuard], loadComponent: () => import('./features/auth/pages/forgot-password/forgot-password').then((m) => m.ForgotPassword), title: 'Forgot password | UAV-PMS' },
  { path: 'otp', canActivate: [guestGuard], loadComponent: () => import('./features/auth/pages/otp/otp').then((m) => m.Otp), title: 'Verify OTP | UAV-PMS' },
  { path: 'reset-password', canActivate: [guestGuard], loadComponent: () => import('./features/auth/pages/reset-password/reset-password').then((m) => m.ResetPassword), title: 'Reset password | UAV-PMS' },
  {
    path: '', canActivate: [authGuard], loadComponent: () => import('./core/layout/shell/shell').then((m) => m.Shell),
    children: [
      { path: 'dashboard', loadComponent: () => import('./features/monitor/pages/dashboard/dashboard').then((m) => m.Dashboard), title: 'Monitoring dashboard | UAV-PMS' },
      { path: 'inspections', loadComponent: () => import('./features/monitor/pages/inspection-history/inspection-history').then((m) => m.InspectionHistory), title: 'Inspection history | UAV-PMS' },
      { path: 'change-password', loadComponent: () => import('./features/auth/pages/change-password/change-password').then((m) => m.ChangePassword), title: 'Change password | UAV-PMS' },
      { path: 'assets', loadComponent: () => import('./features/assets/pages/asset-health-dashboard/asset-health-dashboard').then((m) => m.AssetHealthDashboard), title: 'Asset Health & Risk Dashboard | UAV-PMS' },
      { path: 'assets/:id', loadComponent: () => import('./features/assets/pages/asset-health-dashboard/asset-health-dashboard').then((m) => m.AssetHealthDashboard), title: 'Asset Detail | UAV-PMS' },
      { path: 'ai-analysis/upload', canActivate: [roleGuard(['Admin', 'Manager', 'Analyst'])], loadComponent: () => import('./features/ai-analysis/pages/standalone-upload/standalone-upload').then((m) => m.StandaloneUpload), title: 'AI Analysis Upload | UAV-PMS' },
      { path: 'ai-analysis', redirectTo: 'ai-analysis/upload' },
      { path: 'emergency-alerts', canActivate: [roleGuard(['Admin', 'Manager', 'Analyst'])], loadComponent: () => import('./features/emergency-alerts/pages/emergency-alerts-review/emergency-alerts-review').then((m) => m.EmergencyAlertsReview), title: 'C?nh B�o Kh?n C?p Edge AI | UAV-PMS' },
      { path: 'alerts', redirectTo: 'emergency-alerts' },
      { path: 'ai-review', canActivate: [roleGuard(['Admin', 'Manager', 'Analyst'])], loadComponent: () => import('./features/analyst-review/pages/detection-list/detection-list').then((m) => m.DetectionList), title: 'Duyệt sự cố AI | UAV-PMS' },
      { path: 'ai-review/:id', canActivate: [roleGuard(['Admin', 'Manager', 'Analyst'])], loadComponent: () => import('./features/analyst-review/pages/detection-review/detection-review').then((m) => m.DetectionReview), title: 'Thẩm định phát hiện AI | UAV-PMS' },
      { path: 'gis', canActivate: [roleGuard(['Admin', 'Manager', 'Analyst', 'Inspector'])], loadComponent: () => import('./features/gis/pages/gis-monitoring/gis-monitoring').then((m) => m.GisMonitoring), title: 'Bản đồ GIS Lưới điện | UAV-PMS' },
      { path: 'admin/users', canActivate: [roleGuard(['Admin', 'SystemAdmin'])], loadComponent: () => import('./features/users/pages/user-management/user-management').then((m) => m.UserManagement), title: 'User management | UAV-PMS' },
      { path: 'missions/new', canActivate: [roleGuard(['Admin', 'Manager', 'Inspector'])], loadComponent: () => import('./features/missions/pages/mission-create/mission-create').then((m) => m.MissionCreate), title: 'Create mission | UAV-PMS' },
      { path: 'missions/:id', loadComponent: () => import('./features/missions/pages/mission-detail/mission-detail').then((m) => m.MissionDetail), title: 'Mission detail | UAV-PMS' },
      { path: 'missions', loadComponent: () => import('./features/missions/pages/mission-list/mission-list').then((m) => m.MissionList), title: 'Mission management | UAV-PMS' },
      { path: 'reports', loadComponent: () => import('./features/shared/pages/coming-soon/coming-soon').then((m) => m.ComingSoon), data: { title: 'Reports and analytics' } },
      { path: '403', loadComponent: () => import('./features/shared/pages/forbidden/forbidden').then((m) => m.Forbidden), title: '403 Quyền truy cập bị từ chối | UAV-PMS' },
    ],
  },
  { path: '**', redirectTo: 'dashboard' },
];

