import { DatePipe } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { AbstractControl, FormBuilder, ReactiveFormsModule, ValidationErrors, Validators } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import * as L from 'leaflet';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { GisApi, GisTower, GisTransmissionLine } from '../../../gis/data-access/gis-api';
import { PreMissionApi } from '../../data-access/pre-mission-api';

function formatDatetimeLocal(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

function dateWindowValidator(control: AbstractControl): ValidationErrors | null {
  const start = control.get('plannedStart')?.value;
  const end = control.get('plannedEnd')?.value;
  if (!start || !end) return null;
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (endDate <= startDate) {
    return { endBeforeStart: true };
  }
  return null;
}

function notObsoleteWindowValidator(control: AbstractControl): ValidationErrors | null {
  const start = control.get('plannedStart')?.value;
  if (!start) return null;
  const startDate = new Date(start);
  const now = new Date();
  // Allow 15 minutes buffer for clock skew
  if (startDate.getTime() < now.getTime() - 15 * 60 * 1000) {
    return { startInPast: true };
  }
  return null;
}

@Component({
  selector: 'app-assessment-create',
  imports: [ReactiveFormsModule, RouterLink, NzIconModule, DatePipe],
  templateUrl: './assessment-create.html',
  styleUrl: './assessment-create.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AssessmentCreate implements AfterViewInit, OnDestroy {
  private readonly api = inject(PreMissionApi);
  private readonly gisApi = inject(GisApi);
  private readonly fb = inject(FormBuilder);
  private readonly router = inject(Router);

  protected readonly mapContainer = viewChild<ElementRef<HTMLDivElement>>('createMapContainer');

  protected readonly busy = signal(false);
  protected readonly loadingGis = signal(false);
  protected readonly error = signal('');

  protected readonly regions = signal<readonly { id: string; name: string }[]>([]);
  protected readonly availableLines = signal<readonly GisTransmissionLine[]>([]);
  protected readonly availableTowers = signal<readonly GisTower[]>([]);
  protected readonly selectedTowerCodes = signal<string[]>([]);
  protected readonly selectedBaseLine = signal<string>('');

  // Cache user tower selections per line: Map<lineName, towerCodes[]>
  private readonly lineTowerSelectionCache = new Map<string, string[]>();

  // Leaflet map preview instance
  private map: L.Map | null = null;
  private currentTileLayer: L.TileLayer | null = null;
  private markersLayer: L.LayerGroup | null = null;
  private polylineLayer: L.LayerGroup | null = null;
  private bufferLayer: L.LayerGroup | null = null;
  private resizeObserver: ResizeObserver | null = null;
  protected readonly currentMapType = signal<'google-streets' | 'google-hybrid' | 'google-terrain' | 'carto'>('google-streets');

  // Default time window in LOCAL time: starting in 1 hour, ending in 4 hours
  private readonly defaultStart = formatDatetimeLocal(new Date(Date.now() + 60 * 60 * 1000));
  private readonly defaultEnd = formatDatetimeLocal(new Date(Date.now() + 4 * 60 * 60 * 1000));

  protected readonly form = this.fb.nonNullable.group(
    {
      regionId: ['', [Validators.required]],
      lineName: ['', [Validators.required]],
      scopeAssetIds: ['', [Validators.required]],
      plannedStart: [this.defaultStart, [Validators.required]],
      plannedEnd: [this.defaultEnd, [Validators.required]],
      corridorBufferMeters: [50, [Validators.required, Validators.min(10), Validators.max(500)]],
      maxFlightAltitudeMeters: [120, [Validators.required, Validators.min(20), Validators.max(120)]],
    },
    { validators: [dateWindowValidator, notObsoleteWindowValidator] }
  );

  protected readonly selectedRegionObj = computed(() => {
    const id = this.form.controls.regionId.value;
    return this.regions().find((r) => r.id === id || r.name === id);
  });

  protected readonly filteredTowers = computed(() => {
    const baseLine = this.selectedBaseLine();
    const all = this.availableTowers();
    if (!baseLine) return all.slice(0, 20);
    return all.filter((t) => t.transmissionLineName === baseLine || t.lineAssetId === baseLine);
  });

  protected readonly autoSyncLineName = signal(true);

  protected readonly suggestedLineName = computed(() => {
    const baseLine = this.selectedBaseLine();
    if (!baseLine) return '';
    const towers = this.selectedTowerCodes();
    const allTowersOfLine = this.availableTowers().filter(
      (t) => t.transmissionLineName === baseLine || t.lineAssetId === baseLine
    );
    if (towers.length === 0) return baseLine;
    if (towers.length === allTowersOfLine.length && allTowersOfLine.length > 0) {
      return `${baseLine} (Toàn tuyến - ${towers.length} cột)`;
    }
    if (towers.length === 1) {
      return `${baseLine} (Cột ${towers[0]})`;
    }
    return `${baseLine} (Đoạn ${towers[0]} - ${towers[towers.length - 1]}, ${towers.length} cột)`;
  });

  protected get assetCount(): number {
    const val = this.form.controls.scopeAssetIds.value;
    if (!val) return 0;
    return val.split(/[,\n]/).map((x) => x.trim()).filter(Boolean).length;
  }

  constructor() {
    this.loadRegions();
  }

  ngAfterViewInit(): void {
    setTimeout(() => this.initMap(), 150);
  }

  ngOnDestroy(): void {
    this.cleanupMap();
  }

  private loadRegions(): void {
    this.gisApi.getRegions().subscribe({
      next: (list) => this.regions.set(list),
      error: (err: unknown) => console.warn('Failed to load regions', err),
    });
  }

  protected onRegionSelect(regionId: string): void {
    this.form.controls.regionId.setValue(regionId);
    this.selectedBaseLine.set('');
    this.form.controls.lineName.setValue('');
    this.form.controls.scopeAssetIds.setValue('');
    this.selectedTowerCodes.set([]);
    this.lineTowerSelectionCache.clear();

    if (!regionId) {
      this.availableLines.set([]);
      this.availableTowers.set([]);
      this.renderMap();
      return;
    }

    this.loadingGis.set(true);
    this.gisApi.getAllGisData({ administrativeAreaId: regionId }).subscribe({
      next: (snapshot) => {
        this.availableLines.set(snapshot.lines);
        this.availableTowers.set(snapshot.towers);
        this.loadingGis.set(false);
        this.renderMap();
      },
      error: (err: unknown) => {
        console.warn('Failed to load GIS data', err);
        this.loadingGis.set(false);
      },
    });
  }

  protected onLineSelect(lineName: string): void {
    const prevBaseLine = this.selectedBaseLine();
    if (prevBaseLine) {
      // Save current towers for previous line into cache
      this.lineTowerSelectionCache.set(prevBaseLine, [...this.selectedTowerCodes()]);
    }

    this.selectedBaseLine.set(lineName);

    if (!lineName) {
      this.form.controls.lineName.setValue('');
      this.selectedTowerCodes.set([]);
      this.form.controls.scopeAssetIds.setValue('');
      this.renderMap();
      return;
    }

    // Check if we have cached tower selections for this line
    if (this.lineTowerSelectionCache.has(lineName)) {
      const cached = this.lineTowerSelectionCache.get(lineName)!;
      this.selectedTowerCodes.set(cached);
      this.form.controls.scopeAssetIds.setValue(cached.join(', '));
    } else {
      // Auto-populate all towers of newly selected line
      const lineTowers = this.availableTowers().filter(
        (t) => t.transmissionLineName === lineName || t.lineAssetId === lineName
      );
      const codes = lineTowers.map((t) => t.towerCode);
      this.selectedTowerCodes.set(codes);
      this.form.controls.scopeAssetIds.setValue(codes.join(', '));
      this.lineTowerSelectionCache.set(lineName, codes);
    }

    // Reset auto-sync flag on line select
    this.autoSyncLineName.set(true);
    const suggested = this.suggestedLineName();
    this.form.controls.lineName.setValue(suggested || lineName);
    this.renderMap();
  }

  protected onManualLineNameChange(): void {
    this.autoSyncLineName.set(false);
  }

  protected applySuggestedLineName(): void {
    const suggested = this.suggestedLineName();
    if (suggested) {
      this.form.controls.lineName.setValue(suggested);
      this.autoSyncLineName.set(true);
    }
  }

  protected resetToBaseLineName(): void {
    const base = this.selectedBaseLine();
    if (base) {
      this.form.controls.lineName.setValue(base);
      this.autoSyncLineName.set(false);
    }
  }

  protected toggleTowerSelection(code: string): void {
    const current = new Set(this.selectedTowerCodes());
    if (current.has(code)) {
      current.delete(code);
    } else {
      current.add(code);
    }
    const arr = Array.from(current);
    this.selectedTowerCodes.set(arr);
    this.form.controls.scopeAssetIds.setValue(arr.join(', '));

    const base = this.selectedBaseLine();
    if (base) {
      this.lineTowerSelectionCache.set(base, arr);
    }

    if (this.autoSyncLineName()) {
      const suggested = this.suggestedLineName();
      if (suggested) {
        this.form.controls.lineName.setValue(suggested);
      }
    }
    this.renderMap();
  }

  protected isTowerSelected(code: string): boolean {
    return this.selectedTowerCodes().includes(code);
  }

  protected selectAllFilteredTowers(): void {
    const towers = this.filteredTowers();
    const current = new Set(this.selectedTowerCodes());
    towers.forEach((t) => current.add(t.towerCode));
    const arr = Array.from(current);
    this.selectedTowerCodes.set(arr);
    this.form.controls.scopeAssetIds.setValue(arr.join(', '));

    const base = this.selectedBaseLine();
    if (base) {
      this.lineTowerSelectionCache.set(base, arr);
    }

    if (this.autoSyncLineName()) {
      const suggested = this.suggestedLineName();
      if (suggested) {
        this.form.controls.lineName.setValue(suggested);
      }
    }
    this.renderMap();
  }

  protected clearTowerSelection(): void {
    this.selectedTowerCodes.set([]);
    this.form.controls.scopeAssetIds.setValue('');

    const base = this.selectedBaseLine();
    if (base) {
      this.lineTowerSelectionCache.set(base, []);
    }

    if (this.autoSyncLineName()) {
      const suggested = this.suggestedLineName();
      this.form.controls.lineName.setValue(suggested || base);
    }
    this.renderMap();
  }

  protected onBufferChange(): void {
    this.renderMap();
  }

  protected setMapType(type: 'google-streets' | 'google-hybrid' | 'google-terrain' | 'carto'): void {
    this.currentMapType.set(type);

    if (!this.map) return;

    if (this.currentTileLayer) {
      this.map.removeLayer(this.currentTileLayer);
      this.currentTileLayer = null;
    }

    let tileUrl: string;
    let maxZoom = 20;
    let subdomains = ['mt0', 'mt1', 'mt2', 'mt3'];
    let attribution = '© Google Maps | UAV-PMS GIS';

    switch (type) {
      case 'google-hybrid':
        tileUrl = 'https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}';
        attribution = '© Google Maps Vệ Tinh | UAV-PMS GIS';
        break;
      case 'google-terrain':
        tileUrl = 'https://{s}.google.com/vt/lyrs=p&x={x}&y={y}&z={z}';
        attribution = '© Google Maps Địa Hình | UAV-PMS GIS';
        break;
      case 'carto':
        tileUrl = 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png';
        subdomains = ['a', 'b', 'c', 'd'];
        maxZoom = 19;
        attribution = '© CARTO · OpenStreetMap | EVN UAV-PMS';
        break;
      case 'google-streets':
      default:
        tileUrl = 'https://{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}';
        attribution = '© Google Maps | UAV-PMS GIS';
        break;
    }

    this.currentTileLayer = L.tileLayer(tileUrl, {
      maxZoom,
      subdomains,
      attribution,
      updateWhenIdle: false,
      updateWhenZooming: false,
      keepBuffer: 6,
    });

    let hasFallenBack = false;
    this.currentTileLayer.on('tileerror', () => {
      if (!hasFallenBack && this.currentTileLayer) {
        hasFallenBack = true;
        this.currentTileLayer.setUrl('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png');
      }
    });

    this.currentTileLayer.addTo(this.map);
  }

  private initMap(): void {
    const container = this.mapContainer()?.nativeElement ?? (document.getElementById('createMapContainer') as HTMLDivElement | null);
    if (!container) return;

    if (this.map) {
      if (this.map.getContainer() !== container) {
        try {
          this.map.remove();
        } catch {}
        this.map = null;
      }
    }

    if (!this.map) {
      if ((container as any)._leaflet_id) {
        (container as any)._leaflet_id = null;
      }

      this.map = L.map(container, {
        center: [16.0544, 108.2022],
        zoom: 12,
        zoomControl: true,
      });

      this.setMapType(this.currentMapType());

      this.bufferLayer = L.layerGroup().addTo(this.map);
      this.polylineLayer = L.layerGroup().addTo(this.map);
      this.markersLayer = L.layerGroup().addTo(this.map);

      if (typeof ResizeObserver !== 'undefined') {
        this.resizeObserver = new ResizeObserver(() => {
          this.map?.invalidateSize();
        });
        this.resizeObserver.observe(container);
      }
    }

    setTimeout(() => {
      this.map?.invalidateSize();
      this.renderMap(true);
    }, 120);
  }

  protected fitMapToBounds(): void {
    this.renderMap(true);
  }

  protected refreshMap(): void {
    if (this.map) {
      this.map.invalidateSize();
      this.renderMap(true);
    } else {
      this.initMap();
    }
  }

  private renderMap(autoFit = true): void {
    if (!this.map) {
      this.initMap();
      return;
    }

    this.map.invalidateSize();
    this.markersLayer?.clearLayers();
    this.polylineLayer?.clearLayers();
    this.bufferLayer?.clearLayers();

    const selectedCodes = new Set(this.selectedTowerCodes());
    const allTowers = this.filteredTowers();
    const bufferMeters = Number(this.form.controls.corridorBufferMeters.value || 50);

    const activeCoords: [number, number][] = [];

    // Determine region anchor coordinates
    let baseLat = 16.0544;
    let baseLng = 108.2022;

    const regionId = this.form.controls.regionId.value || '';
    if (regionId.toLowerCase().includes('north') || regionId.toLowerCase().includes('hn')) {
      baseLat = 21.0285;
      baseLng = 105.8542;
    } else if (regionId.toLowerCase().includes('south') || regionId.toLowerCase().includes('hcm')) {
      baseLat = 10.8231;
      baseLng = 106.6297;
    } else if (regionId.toLowerCase().includes('central') || regionId.toLowerCase().includes('cpc') || regionId.toLowerCase().includes('dn')) {
      baseLat = 16.0544;
      baseLng = 108.2022;
    }

    const firstValid = allTowers.find((t) => t.latitude && t.longitude && Math.abs(t.latitude) > 0.1);
    if (firstValid?.latitude && firstValid?.longitude) {
      baseLat = firstValid.latitude;
      baseLng = firstValid.longitude;
    }

    allTowers.forEach((t, idx) => {
      const isSelected = selectedCodes.has(t.towerCode);
      const lat = t.latitude && Number.isFinite(t.latitude) && Math.abs(t.latitude) > 0.1
        ? t.latitude
        : baseLat + idx * 0.0035;
      const lng = t.longitude && Number.isFinite(t.longitude) && Math.abs(t.longitude) > 0.1
        ? t.longitude
        : baseLng + idx * 0.0055;

      if (isSelected) {
        activeCoords.push([lat, lng]);

        // Safety buffer circle around selected tower
        const circle = L.circle([lat, lng], {
          radius: bufferMeters,
          color: '#0284c7',
          fillColor: '#38bdf8',
          fillOpacity: 0.18,
          weight: 1.5,
          dashArray: '4, 4',
        });
        this.bufferLayer?.addLayer(circle);

        // Marker for selected tower
        const marker = L.circleMarker([lat, lng], {
          radius: 8,
          fillColor: '#0052cc',
          color: '#ffffff',
          weight: 2.5,
          fillOpacity: 1,
        });

        const popupHtml = `
          <div style="font-family: inherit; font-size: 11px; line-height: 1.4; min-width: 160px;">
            <strong style="color: #003f99; font-size: 12px;">Vị trí cột: ${t.towerCode}</strong><br/>
            <span style="color: #475569;">Tuyến:</span> ${t.transmissionLineName || this.selectedBaseLine() || 'N/A'}<br/>
            <span style="color: #475569;">Tọa độ:</span> ${lat.toFixed(5)}, ${lng.toFixed(5)}<br/>
            <span style="color: #475569;">Hành lang an toàn:</span> ${bufferMeters}m<br/>
            <span style="display: inline-block; margin-top: 3px; font-weight: 600; color: #047857;">✓ Đang chọn kiểm tra</span>
          </div>
        `;
        marker.bindPopup(popupHtml);
        marker.bindTooltip(t.towerCode, {
          permanent: true,
          direction: 'top',
          className: 'evn-map-tooltip',
          offset: [0, -6],
        });
        this.markersLayer?.addLayer(marker);
      } else {
        // Unselected tower
        const unselectedMarker = L.circleMarker([lat, lng], {
          radius: 5,
          fillColor: '#94a3b8',
          color: '#ffffff',
          weight: 1.5,
          fillOpacity: 0.7,
        });

        const popupHtml = `
          <div style="font-family: inherit; font-size: 11px; line-height: 1.4; min-width: 140px;">
            <strong style="color: #475569;">Vị trí cột: ${t.towerCode}</strong><br/>
            <span style="color: #94a3b8;">Chưa chọn khảo sát</span>
          </div>
        `;
        unselectedMarker.bindPopup(popupHtml);
        unselectedMarker.bindTooltip(t.towerCode, {
          permanent: false,
          direction: 'top',
          className: 'evn-map-tooltip',
        });
        this.markersLayer?.addLayer(unselectedMarker);
      }
    });

    if (activeCoords.length > 1) {
      const poly = L.polyline(activeCoords, {
        color: '#0052cc',
        weight: 3.5,
        dashArray: '6, 6',
      });
      this.polylineLayer?.addLayer(poly);
    }

    if (autoFit) {
      if (activeCoords.length > 0) {
        const bounds = L.latLngBounds(activeCoords);
        this.map.fitBounds(bounds, { padding: [35, 35], maxZoom: 16 });
      } else if (allTowers.length > 0) {
        const allCoords: [number, number][] = allTowers.map((t, idx) => [
          t.latitude && Number.isFinite(t.latitude) && Math.abs(t.latitude) > 0.1
            ? t.latitude
            : baseLat + idx * 0.0035,
          t.longitude && Number.isFinite(t.longitude) && Math.abs(t.longitude) > 0.1
            ? t.longitude
            : baseLng + idx * 0.0055,
        ]);
        this.map.fitBounds(L.latLngBounds(allCoords), { padding: [30, 30], maxZoom: 15 });
      }
    }
  }

  private cleanupMap(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (this.map) {
      this.map.remove();
      this.map = null;
      this.currentTileLayer = null;
      this.markersLayer = null;
      this.polylineLayer = null;
      this.bufferLayer = null;
    }
  }

  protected submit(): void {
    if (this.form.invalid || this.busy()) return;
    this.busy.set(true);
    this.error.set('');

    const raw = this.form.getRawValue();
    const assetIds = raw.scopeAssetIds
      .split(/[,\n]/)
      .map((x) => x.trim())
      .filter(Boolean);

    if (assetIds.length === 0) {
      this.error.set('Vui lòng chọn hoặc nhập ít nhất một mã vị trí/thiết bị cột điện (Asset ID).');
      this.busy.set(false);
      return;
    }

    this.api
      .create({
        regionId: raw.regionId.trim(),
        lineName: raw.lineName.trim() || undefined,
        plannedStart: raw.plannedStart,
        plannedEnd: raw.plannedEnd,
        scopeAssetIds: assetIds,
        scopeGeometry: {
          corridorBufferMeters: raw.corridorBufferMeters,
          maxFlightAltitudeMeters: raw.maxFlightAltitudeMeters,
          geometryType: 'CorridorBuffer',
        },
      })
      .subscribe({
        next: (created) => {
          this.router.navigate(['/pre-mission', created.id]);
        },
        error: (err: unknown) => {
          this.busy.set(false);
          this.error.set(
            extractErrorMessage(
              err,
              'Không thể tạo đánh giá tiền nhiệm vụ. Vui lòng kiểm tra lại thông tin phạm vi và thời gian.'
            )
          );
        },
      });
  }
}

function extractErrorMessage(err: unknown, fallback: string): string {
  if (!err || typeof err !== 'object') return fallback;
  const e = err as Record<string, unknown>;
  const errorObj = e['error'] as Record<string, unknown> | string | undefined;

  if (typeof errorObj === 'string' && errorObj.trim()) return errorObj;
  if (errorObj && typeof errorObj === 'object') {
    if (typeof errorObj['message'] === 'string' && errorObj['message'].trim()) {
      return errorObj['message'];
    }
    if (typeof errorObj['title'] === 'string') {
      const title = errorObj['title'];
      const errors = errorObj['errors'];
      if (errors && typeof errors === 'object') {
        const details = Object.entries(errors as Record<string, string[]>)
          .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : String(v)}`)
          .join('; ');
        return `${title} (${details})`;
      }
      return title;
    }
    if (typeof errorObj['detail'] === 'string' && errorObj['detail'].trim()) {
      return errorObj['detail'];
    }
  }
  if (typeof e['message'] === 'string' && e['message'].trim()) return e['message'];
  return fallback;
}

