import { ChangeDetectionStrategy, Component, computed, DestroyRef, effect, inject, signal, ViewEncapsulation } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { filter } from 'rxjs';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { Header } from '../header/header';
import { Sidebar } from '../sidebar/sidebar';
import { Auth } from '../../auth/auth';

@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, NzIconModule, Header, Sidebar],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Shell {
  protected readonly auth = inject(Auth);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly path = signal(this.router.url);
  protected readonly sidebarOpen = signal(false);
  protected readonly isAssetRoute = computed(() => false);
  constructor() {
    this.router.events.pipe(filter((event): event is NavigationEnd => event instanceof NavigationEnd), takeUntilDestroyed(this.destroyRef)).subscribe((event) => this.path.set(event.urlAfterRedirects));
    effect(() => {
      if (!this.auth.isAuthenticated() && !this.auth.refreshing()) {
        void this.router.navigate(['/login'], { queryParams: { error: 'session_expired' } });
      }
    });
  }
}
