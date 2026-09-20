import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZonelessChangeDetection } from '@angular/core';
import { provideRouter, withComponentInputBinding, withViewTransitions } from '@angular/router';
import { routes } from './app.routes';
import { authInterceptor } from './core/auth/auth-interceptor';
import { provideNzIcons } from 'ng-zorro-antd/icon';
import {
  AppstoreOutline, ArrowLeftOutline, ArrowRightOutline, BellOutline, DashboardOutline,
  DatabaseOutline, ExclamationCircleOutline, EyeInvisibleOutline, FileTextOutline,
  LockOutline, LogoutOutline, MailOutline, MenuOutline, QuestionCircleOutline,
  SearchOutline, SettingOutline, TeamOutline, UserOutline, DownOutline, EnvironmentFill,
  ThunderboltFill, FilterOutline, PlusOutline, EditOutline, MoreOutline, RightOutline,
  ReloadOutline, CheckCircleOutline, LeftOutline, EnvironmentOutline, ThunderboltOutline,
  PictureOutline, BorderOutline, MinusOutline, TagOutline, CloseCircleOutline,
  InfoCircleOutline, SafetyCertificateOutline, ExperimentOutline, AuditOutline, LoadingOutline,
  HistoryOutline, FilePdfOutline, FileExcelOutline, InboxOutline,
} from '@ant-design/icons-angular/icons';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZonelessChangeDetection(),
    provideRouter(routes, withComponentInputBinding(), withViewTransitions()),
    provideHttpClient(withInterceptors([authInterceptor])),
    provideNzIcons([
      AppstoreOutline, ArrowLeftOutline, ArrowRightOutline, BellOutline, DashboardOutline,
      DatabaseOutline, ExclamationCircleOutline, EyeInvisibleOutline, FileTextOutline,
      LockOutline, LogoutOutline, MailOutline, MenuOutline, QuestionCircleOutline,
      SearchOutline, SettingOutline, TeamOutline, UserOutline, DownOutline, EnvironmentFill,
      ThunderboltFill, FilterOutline, PlusOutline, EditOutline, MoreOutline, RightOutline,
      ReloadOutline, CheckCircleOutline, LeftOutline, EnvironmentOutline, ThunderboltOutline,
      PictureOutline, BorderOutline, MinusOutline, TagOutline, CloseCircleOutline,
      InfoCircleOutline, SafetyCertificateOutline, ExperimentOutline, AuditOutline, LoadingOutline,
      HistoryOutline, FilePdfOutline, FileExcelOutline, InboxOutline,
    ]),
  ],
};
