import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { finalize, map, tap } from 'rxjs';
import { environment } from '../../../environments/environment';
import { unwrapApiData } from '../../models/api.models';
import { AuthSession, AuthTokens, AuthUser, LoginResult, OtpResult, UserRole } from '../../models/auth.models';

@Injectable({
  providedIn: 'root',
})
export class Auth {
  private readonly http = inject(HttpClient);
  private readonly sessionKey = 'uavpms.session';
  private readonly sessionState = signal<AuthSession | null>(this.readSession());
  private readonly refreshingState = signal(false);
  private sessionExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  readonly session = this.sessionState.asReadonly();
  readonly refreshing = this.refreshingState.asReadonly();
  readonly user = computed(() => this.sessionState()?.user ?? null);
  readonly isAuthenticated = computed(() => {
    const accessToken = this.sessionState()?.tokens.accessToken;
    return Boolean(accessToken) && !this.isJwtExpired(accessToken!);
  });

  constructor() {
    this.scheduleSessionExpiry(this.sessionState()?.tokens.accessToken);
  }

  login(credentials: { username: string; password: string }) {
    const rawUsername = this.normalizeUsername(credentials.username);
    const normalizedCredentials = {
      username: rawUsername,
      email: rawUsername,
      password: credentials.password,
    };
    return this.http.post<unknown>(`${environment.apiBaseUrl}/auth/login`, normalizedCredentials).pipe(
      map((response): LoginResult => {
        const payload = unwrapApiData<Record<string, unknown>>(response);
        const nested = (payload['authResult'] ?? payload) as Record<string, unknown>;
        if (Boolean(nested['otpRequired']) || !this.hasTokens(nested))
          return { otpRequired: true, email: this.normalizeEmail(String(nested['email'] ?? normalizedCredentials.username)) };
        return { otpRequired: false, session: this.normalizeSession(payload) };
      }),
      tap((result) => {
        if (!result.otpRequired) this.setSession(result.session);
      }),
    );
  }

  sendOtp(request: { email: string; purpose: string }) {
    return this.http.post(`${environment.apiBaseUrl}/auth/otp/send`, { ...request, email: this.normalizeEmail(request.email) });
  }
  verifyOtp(request: { email: string; otp: string; purpose: string }) {
    return this.http.post<unknown>(`${environment.apiBaseUrl}/auth/otp/verify`, { ...request, email: this.normalizeEmail(request.email) }).pipe(
      map((response): OtpResult => {
        const payload = unwrapApiData<Record<string, unknown>>(response);
        const authPayload = payload['authResult'] as Record<string, unknown> | null | undefined;
        if (authPayload && this.hasTokens(authPayload)) {
          this.setSession(this.normalizeSession(authPayload));
          return { authenticated: true };
        }
        return {
          authenticated: false,
          verificationToken:
            String(
              payload['verificationToken'] ?? payload['token'] ?? payload['resetToken'] ?? '',
            ) || undefined,
        };
      }),
    );
  }
  resetPassword(request: { verificationToken: string; newPassword: string }) {
    return this.http.post(`${environment.apiBaseUrl}/auth/reset-password`, request);
  }
  changePassword(newPassword: string) {
    return this.http.post(`${environment.apiBaseUrl}/users/change-password`, { newPassword });
  }

  refresh() {
    this.refreshingState.set(true);
    return this.http
      .post<unknown>(`${environment.apiBaseUrl}/auth/refresh-token`, {
        refreshToken: this.sessionState()?.tokens.refreshToken,
      })
      .pipe(
        map((response) => unwrapApiData<AuthTokens>(response)),
        tap((tokens) => {
          const current = this.sessionState();
          if (current) this.setSession({ ...current, tokens });
        }),
        finalize(() => this.refreshingState.set(false)),
      );
  }

  logout(): void {
    if (this.sessionExpiryTimer) clearTimeout(this.sessionExpiryTimer);
    this.sessionExpiryTimer = null;
    localStorage.removeItem(this.sessionKey);
    // Clear per-session caches to prevent cross-user data contamination
    // when switching accounts on the same browser/domain
    localStorage.removeItem('uav_pms_missions_data_v2');
    localStorage.removeItem('uav_pms_notifications_v1');
    sessionStorage.removeItem('uav_pms_missions_data_v2');
    sessionStorage.removeItem('uav_pms_notifications_v1');
    this.sessionState.set(null);
    this.refreshingState.set(false);
  }

  private setSession(session: AuthSession): void {
    localStorage.setItem(this.sessionKey, JSON.stringify(session));
    this.sessionState.set(session);
    this.scheduleSessionExpiry(session.tokens.accessToken);
  }
  private readSession(): AuthSession | null {
    try {
      const value = localStorage.getItem(this.sessionKey);
      if (!value) return null;
      const session = JSON.parse(value) as AuthSession;
      // If session role is Viewer or missing, attempt to re-resolve from token
      if (session?.tokens?.accessToken && (!session.user?.role || session.user.role === 'Viewer')) {
        const tokenRole = this.parseRoleFromToken(session.tokens.accessToken);
        if (tokenRole && tokenRole !== 'Viewer') {
          const updatedSession: AuthSession = {
            ...session,
            user: { ...session.user, role: tokenRole },
          };
          localStorage.setItem(this.sessionKey, JSON.stringify(updatedSession));
          return updatedSession;
        }
      }
      return session;
    } catch {
      return null;
    }
  }

  private normalizeSession(payload: unknown): AuthSession {
    const source = payload as Record<string, unknown>;
    const nested = (source['authResult'] ?? source) as Record<string, unknown>;
    const rawUser = (nested['user'] ?? {}) as Record<string, unknown>;
    const rawTokens = (nested['tokens'] ?? nested) as Record<string, unknown>;
    const accessToken = String(
      rawTokens['accessToken'] ?? nested['accessToken'] ?? nested['token'] ?? '',
    );
    const refreshToken = String(rawTokens['refreshToken'] ?? nested['refreshToken'] ?? '');
    if (!accessToken || !refreshToken)
      throw new Error('Authentication response did not include tokens.');

    const rawRoles = rawUser['roles'] ?? rawUser['roleNames'];
    const stringRoles = Array.isArray(rawRoles) ? rawRoles.map(String) : [];
    const complexRoles = rawUser['userRoles'] as readonly { role?: { roleName?: string }; roleName?: string }[] | undefined;
    const tokenRole = this.parseRoleFromToken(accessToken);

    const extractedRole =
      stringRoles[0] ??
      complexRoles?.[0]?.role?.roleName ??
      complexRoles?.[0]?.roleName ??
      (rawUser['role'] as string | undefined) ??
      tokenRole ??
      'Viewer';

    const normalizedRole: UserRole =
      extractedRole.toLowerCase() === 'systemadmin' || extractedRole.toLowerCase() === 'admin' || extractedRole.toLowerCase() === 'administrator'
        ? 'Admin'
        : extractedRole.toLowerCase() === 'supervisor' || extractedRole.toLowerCase() === 'manager'
        ? 'Manager'
        : extractedRole.toLowerCase() === 'maintenancetechnician' || extractedRole.toLowerCase() === 'technician'
        ? 'Technician'
        : extractedRole.toLowerCase() === 'inspector' || extractedRole.toLowerCase() === 'pilot'
        ? 'Inspector'
        : extractedRole.toLowerCase() === 'analyst'
        ? 'Analyst'
        : (extractedRole as UserRole);

    const user: AuthUser = {
      id: String(rawUser['id'] ?? ''),
      email: String(rawUser['email'] ?? ''),
      fullName: String(rawUser['fullName'] ?? rawUser['email'] ?? 'Operator'),
      role: normalizedRole,
      mustChangePassword: Boolean(rawUser['mustChangePassword']),
    };
    return { user, tokens: { accessToken, refreshToken } };
  }

  private parseRoleFromToken(token: string): UserRole | undefined {
    try {
      const parts = token.split('.');
      if (parts.length < 2) return undefined;
      const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const jsonPayload = decodeURIComponent(
        atob(base64)
          .split('')
          .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
          .join(''),
      );
      const payload = JSON.parse(jsonPayload) as Record<string, unknown>;
      const roleClaim =
        payload['role'] ??
        payload['http://schemas.microsoft.com/ws/2008/06/identity/claims/role'] ??
        (Array.isArray(payload['roles']) ? payload['roles'][0] : undefined);

      if (typeof roleClaim === 'string') {
        const lower = roleClaim.toLowerCase();
        if (lower === 'systemadmin' || lower === 'admin' || lower === 'administrator') return 'Admin';
        if (lower === 'supervisor' || lower === 'manager') return 'Manager';
        if (lower === 'maintenancetechnician' || lower === 'technician') return 'Technician';
        if (lower === 'inspector' || lower === 'pilot') return 'Inspector';
        if (lower === 'analyst') return 'Analyst';
        return roleClaim as UserRole;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private isJwtExpired(token: string): boolean {
    try {
      const payload = this.parseTokenPayload(token);
      const expiresAtSeconds = Number(payload['exp']);
      return Number.isFinite(expiresAtSeconds) && expiresAtSeconds * 1000 <= Date.now();
    } catch {
      // Some test/dev environments use opaque access tokens without JWT claims.
      return false;
    }
  }

  private scheduleSessionExpiry(token?: string): void {
    if (this.sessionExpiryTimer) clearTimeout(this.sessionExpiryTimer);
    this.sessionExpiryTimer = null;
    if (!token) return;
    try {
      const expiresAtMs = Number(this.parseTokenPayload(token)['exp']) * 1000;
      if (!Number.isFinite(expiresAtMs)) return;
      const remainingMs = expiresAtMs - Date.now();
      if (remainingMs <= 0) return;
      this.sessionExpiryTimer = setTimeout(() => this.logout(), remainingMs);
    } catch {
      // Opaque development tokens do not provide an expiry timestamp.
    }
  }

  private parseTokenPayload(token: string): Record<string, unknown> {
    const parts = token.split('.');
    if (parts.length < 2) throw new Error('Invalid JWT');
    const base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    const jsonPayload = decodeURIComponent(
      atob(padded)
        .split('')
        .map((character) => `%${character.charCodeAt(0).toString(16).padStart(2, '0')}`)
        .join(''),
    );
    return JSON.parse(jsonPayload) as Record<string, unknown>;
  }

  private hasTokens(payload: Record<string, unknown>): boolean {
    const tokens = (payload['tokens'] ?? payload) as Record<string, unknown>;
    return (
      Boolean(tokens['accessToken'] ?? payload['accessToken'] ?? payload['token']) &&
      Boolean(tokens['refreshToken'] ?? payload['refreshToken'])
    );
  }
  private normalizeEmail(email: string): string {
    return email.trim();
  }

  private normalizeUsername(username: string): string {
    return username.trim();
  }
}
