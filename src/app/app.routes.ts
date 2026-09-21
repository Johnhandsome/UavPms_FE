import { Routes } from '@angular/router';
import { authGuard } from './core/auth/auth-guard';
import { guestGuard } from './core/auth/guest-guard';
import { roleGuard } from './core/auth/role-guard';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'dashboard' },
  { path: 'login', canActivate: [guestGuard], loadComponent: () => import('./features/auth/pages/login/login').then((m) => m.Login), title: 'Đăng nhập | UAV-PMS' },
  { path: 'forgot-password', canActivate: [guestGuard], loadComponent: () => import('./features/auth/pages/forgot-password/forgot-password').then((m) => m.ForgotPassword), title: 'Quên mật khẩu | UAV-PMS' },
  { path: 'otp', canActivate: [guestGuard], loadComponent: () => import('./features/auth/pages/otp/otp').then((m) => m.Otp), title: 'Xác thực OTP | UAV-PMS' },
  { path: 'reset-password', canActivate: [guestGuard], loadComponent: () => import('./features/auth/pages/reset-password/reset-password').then((m) => m.ResetPassword), title: 'Đặt lại mật khẩu | UAV-PMS' },
  {
    path: '', canActivate: [authGuard], loadComponent: () => import('./core/layout/shell/shell').then((m) => m.Shell),
    children: [
      { path: 'dashboard', loadComponent: () => import('./features/monitor/pages/dashboard/dashboard').then((m) => m.Dashboard), title: 'Tổng quan giám sát | UAV-PMS' },
      { path: 'inspections', loadComponent: () => import('./features/monitor/pages/inspection-history/inspection-history').then((m) => m.InspectionHistory), title: 'Lịch sử kiểm tra | UAV-PMS' },
      { path: 'change-password', loadComponent: () => import('./features/auth/pages/change-password/change-password').then((m) => m.ChangePassword), title: 'Đổi mật khẩu | UAV-PMS' },
      { path: 'assets', loadComponent: () => import('./features/assets/pages/asset-health-dashboard/asset-health-dashboard').then((m) => m.AssetHealthDashboard), title: 'Sức khỏe & Rủi ro Thiết bị | UAV-PMS' },
      { path: 'assets/:id', loadComponent: () => import('./features/assets/pages/asset-health-dashboard/asset-health-dashboard').then((m) => m.AssetHealthDashboard), title: 'Chi tiết thiết bị | UAV-PMS' },
      { path: 'ai-analysis/upload', canActivate: [roleGuard(['Admin', 'Manager', 'Analyst'])], loadComponent: () => import('./features/ai-analysis/pages/standalone-upload/standalone-upload').then((m) => m.StandaloneUpload), title: 'Phân tích AI | UAV-PMS' },
      { path: 'ai-analysis', redirectTo: 'ai-analysis/upload' },
      { path: 'emergency-alerts', canActivate: [roleGuard(['Admin', 'Manager', 'Analyst'])], loadComponent: () => import('./features/emergency-alerts/pages/emergency-alerts-review/emergency-alerts-review').then((m) => m.EmergencyAlertsReview), title: 'Cảnh Báo Khẩn Cấp Edge AI | UAV-PMS' },
      { path: 'alerts', redirectTo: 'emergency-alerts' },
      { path: 'ai-review', canActivate: [roleGuard(['Admin', 'Manager', 'Analyst'])], loadComponent: () => import('./features/analyst-review/pages/detection-list/detection-list').then((m) => m.DetectionList), title: 'Duyệt sự cố AI | UAV-PMS' },
      { path: 'ai-review/:id', canActivate: [roleGuard(['Admin', 'Manager', 'Analyst'])], loadComponent: () => import('./features/analyst-review/pages/detection-review/detection-review').then((m) => m.DetectionReview), title: 'Thẩm định phát hiện AI | UAV-PMS' },
      { path: 'gis', canActivate: [roleGuard(['Admin', 'Manager', 'Analyst', 'Inspector'])], loadComponent: () => import('./features/gis/pages/gis-monitoring/gis-monitoring').then((m) => m.GisMonitoring), title: 'Bản đồ GIS Lưới điện | UAV-PMS' },
      { path: 'admin/users', canActivate: [roleGuard(['Admin', 'SystemAdmin'])], loadComponent: () => import('./features/users/pages/user-management/user-management').then((m) => m.UserManagement), title: 'Quản lý người dùng | UAV-PMS' },
      { path: 'system/users', redirectTo: 'admin/users' },
      {
        path: 'system/audit-logs',
        canActivate: [roleGuard(['Admin', 'SystemAdmin', 'Manager'])],
        loadComponent: () => import('./features/audit/pages/audit-log-viewer/audit-log-viewer').then((m) => m.AuditLogViewer),
        title: 'Nhật ký hệ thống | UAV-PMS',
      },
      { path: 'admin/audit-logs', redirectTo: 'system/audit-logs' },
      { path: 'audit-logs', redirectTo: 'system/audit-logs' },
      { path: 'missions/create', pathMatch: 'full', redirectTo: 'missions/new' },
      { path: 'pre-mission', loadComponent: () => import('./features/pre-mission/pages/assessment-list/assessment-list').then((m) => m.AssessmentList), title: 'Đánh giá tiền bay | UAV-PMS' },
      { path: 'pre-mission/new', canActivate: [roleGuard(['Admin', 'Manager'])], loadComponent: () => import('./features/pre-mission/pages/assessment-create/assessment-create').then((m) => m.AssessmentCreate), title: 'Tạo đánh giá | UAV-PMS' },
      { path: 'pre-mission/:id', loadComponent: () => import('./features/pre-mission/pages/assessment-workspace/assessment-workspace').then((m) => m.AssessmentWorkspace), title: 'Không gian đánh giá | UAV-PMS' },
      { path: 'missions/new', canActivate: [roleGuard(['Admin', 'Manager'])], loadComponent: () => import('./features/missions/pages/mission-create/mission-create').then((m) => m.MissionCreate), title: 'Tạo nhiệm vụ | UAV-PMS' },
      { path: 'missions/:id/inspector', canActivate: [roleGuard(['Inspector'])], loadComponent: () => import('./features/missions/pages/mission-inspector/mission-inspector').then((m) => m.MissionInspector), title: 'Tiếp nhận nhiệm vụ (Phi công) | UAV-PMS' },
      { path: 'missions/:id', loadComponent: () => import('./features/missions/pages/mission-detail/mission-detail').then((m) => m.MissionDetail), title: 'Chi tiết nhiệm vụ | UAV-PMS' },
      { path: 'missions', loadComponent: () => import('./features/missions/pages/mission-list/mission-list').then((m) => m.MissionList), title: 'Quản lý nhiệm vụ | UAV-PMS' },
      { path: 'reports', loadComponent: () => import('./features/reports/pages/reports-page/reports-page').then((m) => m.ReportsPage), title: 'Báo cáo & Phân tích | UAV-PMS' },
      { path: '403', loadComponent: () => import('./features/shared/pages/forbidden/forbidden').then((m) => m.Forbidden), title: '403 Quyền truy cập bị từ chối | UAV-PMS' },
    ],
  },
  { path: '**', redirectTo: 'dashboard' },
];
