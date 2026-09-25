import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { catchError, map } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { unwrapApiData } from '../../../models/api.models';
import { AppNotification } from '../../../models/notification.models';

@Injectable({
  providedIn: 'root',
})
export class NotificationsApi {
  private readonly http = inject(HttpClient);
  private readonly baseUrl = `${environment.apiBaseUrl}/notifications`;

  getHistory(userId?: string) {
    let params = new HttpParams().set('limit', '50');
    if (userId) params = params.set('userId', userId);
    return this.http
      .get<unknown>(`${this.baseUrl}/history`, { params })
      .pipe(
        catchError(() => this.http.get<unknown>(this.baseUrl, { params })),
        map((response) => normalizeArray(unwrapApiData(response)).map((item) => normalizeNotification(item)))
      );
  }

  getById(id: string) {
    return this.http
      .get<unknown>(`${this.baseUrl}/${id}`)
      .pipe(map((response) => normalizeNotification(unwrapApiData(response))));
  }

  markRead(id: string) {
    return this.http
      .put<unknown>(`${this.baseUrl}/${id}/read`, null)
      .pipe(map((response) => normalizeNotification(unwrapApiData(response), id)));
  }

  delete(id: string) {
    return this.http.delete<unknown>(`${this.baseUrl}/${id}`);
  }
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const pick = (source: Record<string, unknown>, ...keys: string[]) =>
  keys.map((key) => source[key]).find((value) => value !== undefined && value !== null);

const stringValue = (value: unknown, fallback = '') =>
  value === undefined || value === null ? fallback : String(value);

const boolValue = (value: unknown) => value === true || value === 'true' || value === 1;

const normalizeArray = (value: unknown): readonly unknown[] => {
  if (Array.isArray(value)) return value;
  const source = record(value);
  const list = pick(source, 'items', 'results', 'records', 'notifications', 'data');
  return Array.isArray(list) ? list : [];
};

export const normalizeNotification = (value: unknown, fallbackId = ''): AppNotification => {
  const source = record(value);
  const id = stringValue(pick(source, 'id', 'notificationId'), fallbackId);
  const createdAt = stringValue(
    pick(source, 'createdAt', 'createdTime', 'createdDate', 'timestamp', 'sentAt'),
    new Date(0).toISOString(),
  );
  const readAt = pick(source, 'readAt', 'readTime');
  return {
    id,
    userId: stringValue(pick(source, 'userId', 'recipientId')) || undefined,
    type: stringValue(pick(source, 'type', 'notificationType')) || undefined,
    referenceType: stringValue(pick(source, 'referenceType', 'entityType')) || undefined,
    referenceId: stringValue(pick(source, 'referenceId', 'entityId')) || undefined,
    title: stringValue(pick(source, 'title', 'subject'), 'Notification'),
    body: stringValue(pick(source, 'body', 'message', 'content', 'description')),
    createdAt,
    isRead: boolValue(pick(source, 'isRead', 'read', 'seen')) || Boolean(readAt),
  };
};
