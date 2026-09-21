import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { finalize } from 'rxjs';
import { AppNotification, NotificationFilters, NotificationReadFilter, NotificationSort } from '../../../models/notification.models';
import { NotificationsApi } from './notifications-api';
import { NotificationsRealtime } from './notifications-realtime';

@Injectable({
  providedIn: 'root',
})
export class NotificationsStore {
  private readonly api = inject(NotificationsApi);
  private readonly realtime = inject(NotificationsRealtime);
  private readonly destroyRef = inject(DestroyRef);
  private readonly notificationsState = signal<readonly AppNotification[]>([]);
  private readonly selectedState = signal<AppNotification | null>(null);
  private realtimeStarted = false;

  readonly loading = signal(false);
  readonly detailLoading = signal(false);
  readonly deletingId = signal('');
  readonly error = signal('');
  readonly realtimeStatus = signal<'connected' | 'disconnected' | 'reconnecting'>('disconnected');
  readonly filters = signal<NotificationFilters>({ read: 'all', type: '', sort: 'newest' });
  readonly notifications = this.notificationsState.asReadonly();
  readonly selected = this.selectedState.asReadonly();
  readonly unreadCount = computed(() => this.notificationsState().filter((item) => !item.isRead).length);
  readonly types = computed(() => Array.from(new Set(this.notificationsState().map((item) => item.type).filter(Boolean))).sort() as string[]);
  readonly filteredNotifications = computed(() => {
    const filters = this.filters();
    const items = this.notificationsState().filter((item) => {
      const readMatch =
        filters.read === 'all' ||
        (filters.read === 'read' && item.isRead) ||
        (filters.read === 'unread' && !item.isRead);
      const typeMatch = !filters.type || item.type === filters.type;
      return readMatch && typeMatch;
    });
    return sortNotifications(items, filters.sort);
  });
  readonly unreadNotifications = computed(() => this.filteredNotifications().filter((item) => !item.isRead));
  readonly readNotifications = computed(() => this.filteredNotifications().filter((item) => item.isRead));

  constructor() {
    this.realtime.notifications$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((notification) => this.upsert(notification));
    this.realtime.status$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((status) => this.realtimeStatus.set(status));
  }

  connect(userId?: string): void {
    if (!this.realtimeStarted) {
      this.realtimeStarted = true;
      this.load(userId);
      this.realtime.connect();
      return;
    }
    this.realtime.connect();
  }

  disconnect(): void {
    this.realtimeStarted = false;
    this.realtime.disconnect();
    this.realtimeStatus.set('disconnected');
  }

  load(userId?: string, showLoading = true): void {
    if (showLoading) this.loading.set(true);
    this.error.set('');
    this.api
      .getHistory(userId)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => { if (showLoading) this.loading.set(false); }),
      )
      .subscribe({
        next: (items) => this.notificationsState.set(sortNotifications(items, 'newest')),
        error: () => this.error.set('Notifications could not be loaded.'),
      });
  }

  select(notification: AppNotification): void {
    this.detailLoading.set(true);
    this.error.set('');
    this.api
      .getById(notification.id)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.detailLoading.set(false)),
      )
      .subscribe({
        next: (detail) => {
          const merged = { ...notification, ...detail };
          this.selectedState.set(merged);
          this.upsert(merged);
          if (!merged.isRead) this.markRead(merged.id);
        },
        error: () => {
          this.selectedState.set(notification);
          if (!notification.isRead) this.markRead(notification.id);
        },
      });
  }

  clearSelection(): void {
    this.selectedState.set(null);
  }

  setReadFilter(read: NotificationReadFilter): void {
    this.filters.update((value) => ({ ...value, read }));
  }

  setTypeFilter(type: string): void {
    this.filters.update((value) => ({ ...value, type }));
  }

  setSortFilter(sort: NotificationSort): void {
    this.filters.update((value) => ({ ...value, sort }));
  }

  markRead(id: string): void {
    this.api
      .markRead(id)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: () => this.patch(id, { isRead: true }),
        error: () => this.patch(id, { isRead: true }),
      });
  }

  delete(id: string): void {
    this.deletingId.set(id);
    this.api
      .delete(id)
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.deletingId.set('')),
      )
      .subscribe({
        next: () => {
          this.notificationsState.update((items) => items.filter((item) => item.id !== id));
          if (this.selectedState()?.id === id) this.selectedState.set(null);
        },
        error: () => this.error.set('Notification could not be deleted.'),
      });
  }

  private patch(id: string, patch: Partial<AppNotification>): void {
    this.notificationsState.update((items) => items.map((item) => (item.id === id ? { ...item, ...patch } : item)));
    if (this.selectedState()?.id === id) this.selectedState.update((item) => (item ? { ...item, ...patch } : item));
  }

  upsert(notification: AppNotification): void {
    this.notificationsState.update((items) => {
      const exists = items.some((item) => item.id === notification.id);
      return sortNotifications(exists ? items.map((item) => (item.id === notification.id ? notification : item)) : [notification, ...items], this.filters().sort);
    });
    if (this.selectedState()?.id === notification.id) this.selectedState.set(notification);
  }
}

const sortNotifications = (items: readonly AppNotification[], sort: NotificationSort) =>
  [...items].sort((a, b) => {
    const delta = Date.parse(b.createdAt) - Date.parse(a.createdAt);
    return sort === 'newest' ? delta : -delta;
  });
