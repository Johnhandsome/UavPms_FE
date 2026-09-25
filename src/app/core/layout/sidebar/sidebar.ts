import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { Auth } from '../../auth/auth';
import { EmergencyAlertsApi } from '../../../features/emergency-alerts/data-access/emergency-alerts-api';

export interface NavLinkItem {
  readonly path: string;
  readonly icon: string;
  readonly label: string;
  readonly exact?: boolean;
  readonly badgeCount?: number;
}

@Component({
  selector: 'app-sidebar',
  host: { style: 'display: contents' },
  imports: [RouterLink, RouterLinkActive, NzIconModule],
  templateUrl: './sidebar.html',
  styleUrl: './sidebar.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Sidebar {
  private readonly auth = inject(Auth);
  private readonly alertsApi = inject(EmergencyAlertsApi);

  readonly open = input(false);
  readonly closed = output<void>();

  protected readonly user = computed(() => this.auth.user());
  protected readonly role = computed(() => (this.user()?.role || '').toLowerCase());
  protected readonly activeAlertCount = computed(() => this.alertsApi.activeCount());

  protected readonly primaryLinks = computed<readonly NavLinkItem[]>(() => {
    const currentRole = this.role();

    // 1. SystemAdmin / Admin
    if (currentRole === 'admin' || currentRole === 'systemadmin' || currentRole === 'administrator') {
      return [
        { path: '/dashboard', icon: 'dashboard', label: 'Trang chủ' },
        { path: '/gis', icon: 'environment', label: 'Bản đồ GIS' },
        { path: '/assets', icon: 'safety-certificate', label: 'Thiết bị lưới điện' },
        { path: '/missions', icon: 'appstore', label: 'Nhiệm vụ bay' },
        { path: '/pre-mission', icon: 'file-protect', label: 'Đánh giá tiền bay' },
        { path: '/ai-review', icon: 'audit', label: 'Duyệt sự cố AI' },
        { path: '/inspections', icon: 'file-text', label: 'Lịch sử kiểm tra' },
        { path: '/reports', icon: 'file-text', label: 'Báo cáo' },
        { path: '/admin/users', icon: 'team', label: 'Người dùng' },
      ];
    }

    // 2. Manager / Supervisor
    if (currentRole === 'manager' || currentRole === 'supervisor') {
      return [
        { path: '/dashboard', icon: 'dashboard', label: 'Trang chủ' },
        { path: '/gis', icon: 'environment', label: 'Bản đồ GIS' },
        { path: '/assets', icon: 'safety-certificate', label: 'Thiết bị lưới điện' },
        { path: '/missions', icon: 'appstore', label: 'Nhiệm vụ bay' },
        { path: '/pre-mission', icon: 'file-protect', label: 'Đánh giá tiền bay' },
        { path: '/ai-review', icon: 'audit', label: 'Duyệt sự cố AI' },
        { path: '/inspections', icon: 'file-text', label: 'Lịch sử kiểm tra' },
        { path: '/reports', icon: 'file-text', label: 'Báo cáo' },
      ];
    }

    // 3. Inspector (Pilot)
    if (currentRole === 'inspector' || currentRole === 'pilot') {
      return [
        { path: '/dashboard', icon: 'dashboard', label: 'Trang chủ' },
        { path: '/gis', icon: 'environment', label: 'Bản đồ GIS' },
        { path: '/missions', icon: 'appstore', label: 'Nhiệm vụ bay' },
        { path: '/assets', icon: 'safety-certificate', label: 'Thiết bị lưới điện' },
        { path: '/inspections', icon: 'file-text', label: 'Lịch sử & Log bay' },
      ];
    }

    // 4. Analyst (AI Specialist)
    if (currentRole === 'analyst') {
      return [
        { path: '/dashboard', icon: 'dashboard', label: 'Trang chủ' },
        { path: '/missions', icon: 'appstore', label: 'Nhiệm vụ bay' },
        { path: '/gis', icon: 'environment', label: 'Bản đồ GIS' },
        { path: '/ai-review', icon: 'audit', label: 'Duyệt sự cố AI' },
        { path: '/ai-analysis/upload', icon: 'experiment', label: 'Phân tích AI' },
        { path: '/assets', icon: 'safety-certificate', label: 'Thiết bị lưới điện' },
        { path: '/inspections', icon: 'file-text', label: 'Lịch sử kiểm tra' },
        { path: '/reports', icon: 'file-text', label: 'Báo cáo' },
      ];
    }

    // 5. Technician / MaintenanceTechnician
    if (currentRole === 'technician' || currentRole === 'maintenancetechnician') {
      return [
        { path: '/dashboard', icon: 'dashboard', label: 'Trang chủ' },
        { path: '/missions', icon: 'appstore', label: 'Nhiệm vụ bay' },
        { path: '/gis', icon: 'environment', label: 'Bản đồ GIS' },
        { path: '/assets', icon: 'safety-certificate', label: 'Thiết bị lưới điện' },
        { path: '/inspections', icon: 'file-text', label: 'Công việc & Sự cố' },
        { path: '/reports', icon: 'file-text', label: 'Báo cáo' },
      ];
    }

    // Default / Viewer fallback
    return [
      { path: '/dashboard', icon: 'dashboard', label: 'Trang chủ' },
      { path: '/gis', icon: 'environment', label: 'Bản đồ GIS' },
      { path: '/assets', icon: 'safety-certificate', label: 'Thiết bị lưới điện' },
      { path: '/missions', icon: 'appstore', label: 'Nhiệm vụ bay' },
      { path: '/inspections', icon: 'file-text', label: 'Lịch sử kiểm tra' },
      { path: '/reports', icon: 'file-text', label: 'Báo cáo' },
    ];
  });

  protected readonly secondaryLinks = computed<readonly NavLinkItem[]>(() => {
    const currentRole = this.role();
    if (currentRole === 'admin' || currentRole === 'systemadmin' || currentRole === 'administrator') {
      return [
        { path: '/system/audit-logs', icon: 'history', label: 'Nhật ký hệ thống' },
        { path: '/system', icon: 'setting', label: 'Cấu hình hệ thống', exact: true },
        { path: '/inspections', icon: 'question-circle', label: 'Hỗ trợ' },
      ];
    }
    if (currentRole === 'manager' || currentRole === 'supervisor') {
      return [
        { path: '/system/audit-logs', icon: 'history', label: 'Nhật ký hệ thống' },
        { path: '/inspections', icon: 'question-circle', label: 'Hỗ trợ' },
      ];
    }
    return [
      { path: '/inspections', icon: 'question-circle', label: 'Trợ giúp' },
    ];
  });
}
