import { DatePipe } from '@angular/common';
import {
  AfterViewInit,
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  ElementRef,
  inject,
  OnDestroy,
  signal,
  viewChild,
  ViewEncapsulation,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import * as L from 'leaflet';
import 'leaflet-draw';
import { NzIconModule } from 'ng-zorro-antd/icon';
import { finalize, map, Observable } from 'rxjs';
import { GeoJsonPolygon, SelectableAsset } from '../../../../models/assets.models';
import { Auth } from '../../../../core/auth/auth';
import { MissionTargetSelection } from '../../../missions/data-access/mission-target-selection';
import {
  GisAlert,
  GisAnomalyFeature,
  GisApi,
  GisTower,
  GisTransmissionLine,
} from '../../data-access/gis-api';

import { Mission } from '../../../../models/missions.models';
import { MissionsApi } from '../../../missions/data-access/missions-api';

export type MapType = 'google-streets' | 'google-hybrid' | 'google-terrain' | 'osm';
export type SelectionDrawMode = 'none' | 'rectangle' | 'polygon';
export type SelectionUxState = 'idle' | 'choosing' | 'drawing-rectangle' | 'drawing-polygon' | 'editing' | 'querying' | 'success' | 'empty' | 'error';

export const rectangleToPolygon = (first: { lat: number; lng: number }, second: { lat: number; lng: number }): GeoJsonPolygon => {
  const west = Math.min(first.lng, second.lng); const east = Math.max(first.lng, second.lng);
  const south = Math.min(first.lat, second.lat); const north = Math.max(first.lat, second.lat);
  return { type: 'Polygon', coordinates: [[[west, south], [east, south], [east, north], [west, north], [west, south]]] };
};

export interface MissionTargetCluster {
  readonly assetKey: string;
  readonly towerCode: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly missions: readonly Mission[];
}

type SelectedGisEntity =
  | { type: 'tower'; data: GisTower }
  | { type: 'anomaly'; data: GisAnomalyFeature }
  | { type: 'alert'; data: GisAlert }
  | { type: 'missionCluster'; data: MissionTargetCluster };

@Component({
  selector: 'app-gis-monitoring',
  imports: [DatePipe, RouterLink, FormsModule, NzIconModule],
  templateUrl: './gis-monitoring.html',
  styleUrl: './gis-monitoring.scss',
  encapsulation: ViewEncapsulation.None,
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { '(document:keydown)': 'onKeydown($event)' },
})
export class GisMonitoring implements AfterViewInit, OnDestroy {
  private readonly gisApi = inject(GisApi);
  private readonly missionsApi = inject(MissionsApi);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  private readonly auth = inject(Auth);
  protected readonly targetSelection = inject(MissionTargetSelection);
  private readonly mapContainer = viewChild<ElementRef<HTMLDivElement>>('mapContainer');

  // Permission check for viewing missions based on user role
  protected readonly canViewMissions = computed(() => {
    const role = (this.auth.user()?.role || '').toLowerCase();
    return (
      role === 'admin' ||
      role === 'systemadmin' ||
      role === 'administrator' ||
      role === 'manager' ||
      role === 'supervisor' ||
      role === 'inspector' ||
      role === 'pilot' ||
      role === 'analyst'
    );
  });

  // Permission check for creating missions based on existing user role
  protected readonly canCreateMission = computed(() => {
    const role = (this.auth.user()?.role || '').toLowerCase();
    return (
      role === 'admin' ||
      role === 'systemadmin' ||
      role === 'administrator' ||
      role === 'manager' ||
      role === 'supervisor' ||
      role === 'inspector' ||
      role === 'pilot'
    );
  });

  private map: L.Map | null = null;
  private currentTileLayer: L.TileLayer | null = null;
  private towersLayer = L.layerGroup();
  private linesLayer = L.layerGroup();
  private defectsLayer = L.layerGroup();
  private alertsLayer = L.layerGroup();
  private missionsLayer = L.layerGroup();
  private selectionResultsLayer = L.layerGroup();
  private confirmedTargetsLayer = L.layerGroup();
  private selectionBoundary: L.Polygon | L.Rectangle | null = null;
  private readonly editableLayers = L.featureGroup();
  private editHandler: L.EditToolbar.Edit | null = null;
  private currentGeometry: GeoJsonPolygon | null = null;

  // Custom Live Drawing Layers & State
  private tempDrawLayer = L.layerGroup();
  private tempRect: L.Rectangle | null = null;
  private rectStartLatLng: L.LatLng | null = null;
  private isRectDragging = false;
  protected readonly polygonVertices = signal<L.LatLng[]>([]);
  private tempPolyline: L.Polyline | null = null;
  private tempRubberband: L.Polyline | null = null;
  private tempVertexMarkers: L.Marker[] = [];

  // Map type state
  protected readonly currentMapType = signal<MapType>('google-streets');

  // GIS remains empty until authorized API data arrives.
  protected readonly towers = signal<readonly GisTower[]>([]);
  protected readonly lines = signal<readonly GisTransmissionLine[]>([]);
  protected readonly anomalies = signal<readonly GisAnomalyFeature[]>([]);
  protected readonly alerts = signal<readonly GisAlert[]>([]);
  protected readonly missions = signal<readonly Mission[]>([]);
  protected readonly missionsLoading = signal(false);
  protected readonly missionsError = signal('');

  // State signals
  protected readonly loading = signal(false);
  protected readonly error = signal('');
  protected readonly showFilterPanel = signal(false);
  protected readonly showLegendPanel = signal(true);
  protected readonly selectedEntity = signal<SelectedGisEntity | null>(null);
  protected readonly drawMode = signal<SelectionDrawMode>('none');
  protected readonly uxState = signal<SelectionUxState>('idle');
  protected readonly showSelectionPopup = signal(false);
  protected readonly hasBoundary = signal(false);
  protected readonly spatialLoading = signal(false);
  protected readonly spatialMessage = signal('');
  protected readonly spatialAssets = signal<readonly SelectableAsset[]>([]);
  protected readonly drawingInstruction = computed(() => this.drawMode() === 'rectangle'
    ? 'Nhấn và kéo trên bản đồ để tạo vùng.'
    : this.drawMode() === 'polygon' ? 'Nhấp để đặt từng điểm.\nNhấp điểm đầu để hoàn tất.' : '');
  protected readonly missionCtaLabel = computed(() => this.targetSelection.count() ? `Tạo nhiệm vụ (${this.targetSelection.count()})` : 'Tạo nhiệm vụ');

  // Popup title computed
  protected readonly popupTitle = computed(() => {
    const state = this.uxState();
    if (state === 'editing') return 'Chỉnh sửa vùng';
    if (state === 'querying') return 'Tài sản trong vùng';
    if (state === 'success') {
      const count = this.spatialAssets().length;
      return `Tài sản trong vùng (${count})`;
    }
    if (state === 'empty') return 'Tài sản trong vùng (0)';
    if (state === 'error') return 'Tài sản trong vùng';
    return 'Chọn tài sản theo vùng';
  });

  // Check if all spatial candidates are selected
  protected readonly isAllSpatialSelected = computed(() => {
    const list = this.spatialAssets();
    if (!list.length) return false;
    return list.every((a) => this.targetSelection.has(a.assetId));
  });

  // Toggle select all / deselect all spatial candidates
  protected toggleSelectAllSpatial(): void {
    if (this.isAllSpatialSelected()) {
      this.spatialAssets().forEach((a) => this.targetSelection.remove(a.assetId));
    } else {
      this.targetSelection.addMany(this.spatialAssets());
    }
    this.renderSpatialAssets();
  }

  // Layer Visibility
  protected readonly showTowersLayer = signal(true);
  protected readonly showLinesLayer = signal(true);
  protected readonly showDefectsLayer = signal(true);
  protected readonly showAlertsLayer = signal(true);
  protected readonly showMissionsLayer = signal(true);
  protected readonly includeCompletedMissions = signal(false);

  // Filters
  protected readonly searchCode = signal('');
  protected readonly severityFilter = signal<string>('');
  protected readonly statusFilter = signal<string>('');

  // Computed metrics
  protected readonly totalTowersCount = computed(() => this.towers().length);
  protected readonly activeDefectsCount = computed(() => this.anomalies().length);
  protected readonly criticalAlertsCount = computed(
    () => this.alerts().filter((a) => a.priority === 'Critical' && a.status === 'Active').length,
  );
  protected readonly activeMissionsCount = computed(() => this.missions().length);

  protected readonly filteredAnomalies = computed(() => {
    const list = this.anomalies();
    const query = this.searchCode().trim().toLowerCase();
    const sev = this.severityFilter();
    const status = this.statusFilter();

    return list.filter((item) => {
      if (query && !item.assetCode.toLowerCase().includes(query) && !item.towerCode.toLowerCase().includes(query)) {
        return false;
      }
      if (sev && String(item.severity) !== sev) {
        return false;
      }
      if (status && item.status.toLowerCase() !== status.toLowerCase()) {
        return false;
      }
      return true;
    });
  });

  ngAfterViewInit(): void {
    this.initLeafletMap();

    // 1. Initialize empty map layers
    this.renderAllLayers();
    this.fitMapBounds();

    // 2. Multi-stage layout synchronization across browser paint lifecycle
    requestAnimationFrame(() => {
      if (!this.map) return;
      this.map.invalidateSize();
      this.renderAllLayers();
      this.fitMapBounds();
    });

    setTimeout(() => {
      if (!this.map) return;
      this.map.invalidateSize();
      this.renderAllLayers();
      this.fitMapBounds();
    }, 200);

    setTimeout(() => {
      if (!this.map) return;
      this.map.invalidateSize();
      this.renderAllLayers();
      this.fitMapBounds();
    }, 500);

    // 3. Refresh live data from server asynchronously
    this.loadGisData();
  }

  ngOnDestroy(): void {
    if (this.map) {
      this.map.remove();
      this.map = null;
    }
  }

  private initLeafletMap(): void {
    const container = this.mapContainer()?.nativeElement;
    if (!container) return;

    const vietnamBounds = L.latLngBounds([8.15, 102.0], [23.5, 110.0]);
    this.map = L.map(container, {
      center: [16.2, 106.2],
      zoom: 5,
      zoomControl: false,
      maxBounds: vietnamBounds,
      maxBoundsViscosity: 1,
    });

    // Custom zoom control in bottom right
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);

    // Apply initial Tile Layer (Google Maps Streets)
    this.setMapType('google-streets');

    // Add Layer Groups
    this.linesLayer.addTo(this.map);
    this.towersLayer.addTo(this.map);
    this.defectsLayer.addTo(this.map);
    this.alertsLayer.addTo(this.map);
    this.missionsLayer.addTo(this.map);
    this.selectionResultsLayer.addTo(this.map);
    this.confirmedTargetsLayer.addTo(this.map);
    this.editableLayers.addTo(this.map);
    this.tempDrawLayer.addTo(this.map);

    // When map is ready in DOM, force immediate projection and layer rendering
    this.map.whenReady(() => {
      this.map?.invalidateSize();
      this.map?.fitBounds(vietnamBounds);
      this.renderAllLayers();
      this.fitMapBounds();
    });

    // Register Map Event Listeners for Live Custom Drawing
    this.map.on('mousedown', (e: L.LeafletMouseEvent) => this.onMapMouseDown(e));
    this.map.on('mousemove', (e: L.LeafletMouseEvent) => this.onMapMouseMove(e));
    this.map.on('mouseup', (e: L.LeafletMouseEvent) => this.onMapMouseUp(e));
    this.map.on('click', (e: L.LeafletMouseEvent) => this.onMapClick(e));
    this.map.on('dblclick', (e: L.LeafletMouseEvent) => this.onMapDblClick(e));
    this.map.on(L.Draw.Event.EDITED, () => this.onEditCompleted());
  }

  /** Toggle the selection tool: open/close the popup. */
  protected toggleSelectionTool(): void {
    if (this.showSelectionPopup()) {
      this.closeSelectionPopup();
    } else {
      this.showSelectionPopup.set(true);
      if (!this.hasBoundary()) {
        this.uxState.set('choosing');
      }
    }
  }

  /** Close the selection popup. Handles different states per spec. */
  protected closeSelectionPopup(): void {
    const state = this.uxState();
    if (state === 'drawing-rectangle' || state === 'drawing-polygon' || state === 'editing') {
      this.cancelActiveTool();
    }
    this.showSelectionPopup.set(false);
  }

  /** Redraw: clear candidates + geometry, return to shape chooser, preserve confirmed targets. */
  protected redraw(): void {
    this.cancelActiveTool();
    this.editableLayers.clearLayers();
    this.selectionBoundary?.remove();
    this.selectionBoundary = null;
    this.currentGeometry = null;
    this.hasBoundary.set(false);
    this.spatialAssets.set([]);
    this.selectionResultsLayer.clearLayers();
    this.renderConfirmedTargetMarkers();
    this.spatialMessage.set('');
    this.uxState.set('choosing');
  }

  protected startDrawing(mode: Exclude<SelectionDrawMode, 'none'>): void {
    this.cancelActiveTool();
    this.drawMode.set(mode);
    this.uxState.set(mode === 'rectangle' ? 'drawing-rectangle' : 'drawing-polygon');

    if (this.map) {
      if (mode === 'rectangle') {
        this.map.dragging.disable();
      } else if (mode === 'polygon') {
        this.map.doubleClickZoom.disable();
        this.polygonVertices.set([]);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Custom Live Rectangle & Polygon Drawing Handlers
  // ─────────────────────────────────────────────────────────────

  private onMapMouseDown(e: L.LeafletMouseEvent): void {
    if (this.drawMode() !== 'rectangle' || !this.map) return;
    if (e.originalEvent) {
      L.DomEvent.preventDefault(e.originalEvent);
    }
    this.isRectDragging = true;
    this.rectStartLatLng = e.latlng;

    if (this.tempRect) {
      this.tempRect.remove();
    }

    const bounds = L.latLngBounds(e.latlng, e.latlng);
    this.tempRect = L.rectangle(bounds, {
      color: '#4f46e5',
      weight: 2,
      fillColor: '#6366f1',
      fillOpacity: 0.16,
      dashArray: '6 4',
    }).addTo(this.tempDrawLayer);
  }

  private onMapMouseMove(e: L.LeafletMouseEvent): void {
    if (!this.map) return;

    // Rectangle live preview during drag
    if (this.drawMode() === 'rectangle' && this.isRectDragging && this.rectStartLatLng && this.tempRect) {
      if (e.originalEvent) {
        L.DomEvent.preventDefault(e.originalEvent);
      }
      const bounds = L.latLngBounds(this.rectStartLatLng, e.latlng);
      this.tempRect.setBounds(bounds);
      return;
    }

    // Polygon live rubberband guide line
    if (this.drawMode() === 'polygon') {
      const points = this.polygonVertices();
      if (points.length > 0) {
        const lastPoint = points[points.length - 1];
        if (!this.tempRubberband) {
          this.tempRubberband = L.polyline([lastPoint, e.latlng], {
            color: '#4f46e5',
            weight: 2,
            dashArray: '4 4',
            opacity: 0.8,
          }).addTo(this.tempDrawLayer);
        } else {
          this.tempRubberband.setLatLngs([lastPoint, e.latlng]);
        }
      }
    }
  }

  private onMapMouseUp(e: L.LeafletMouseEvent): void {
    if (this.drawMode() !== 'rectangle' || !this.isRectDragging || !this.rectStartLatLng || !this.map) return;
    if (e.originalEvent) {
      L.DomEvent.preventDefault(e.originalEvent);
    }
    this.isRectDragging = false;

    const bounds = L.latLngBounds(this.rectStartLatLng, e.latlng);
    const startPoint = this.map.latLngToLayerPoint(this.rectStartLatLng);
    const endPoint = this.map.latLngToLayerPoint(e.latlng);
    const distance = startPoint.distanceTo(endPoint);

    this.tempRect?.remove();
    this.tempRect = null;
    this.rectStartLatLng = null;

    if (distance >= 8) {
      const geojson = rectangleToPolygon(bounds.getNorthEast(), bounds.getSouthWest());
      this.resolveGeometry(geojson);
    }
  }

  private onMapClick(e: L.LeafletMouseEvent): void {
    if (this.drawMode() !== 'polygon' || !this.map) return;

    const currentPoints = this.polygonVertices();

    // Check if clicked near the first point to close polygon
    if (currentPoints.length >= 3) {
      const firstPointPx = this.map.latLngToLayerPoint(currentPoints[0]);
      const clickPx = this.map.latLngToLayerPoint(e.latlng);
      if (firstPointPx.distanceTo(clickPx) <= 18) {
        this.completePolygon();
        return;
      }
    }

    // Add new vertex to polygon
    const newPoints = [...currentPoints, e.latlng];
    this.polygonVertices.set(newPoints);

    // Create marker for this vertex
    const isFirst = newPoints.length === 1;
    const markerIcon = L.divIcon({
      className: `leaflet-editing-icon ${isFirst ? 'first-vertex-marker' : ''}`,
      iconSize: isFirst ? [14, 14] : [10, 10],
      iconAnchor: isFirst ? [7, 7] : [5, 5],
    });

    const marker = L.marker(e.latlng, { icon: markerIcon }).addTo(this.tempDrawLayer);

    if (isFirst) {
      marker.bindTooltip('Nhấp vào đây để hoàn tất vùng', { direction: 'top', offset: [0, -8] });
      marker.on('click', (ev: L.LeafletMouseEvent) => {
        L.DomEvent.stopPropagation(ev);
        if (this.polygonVertices().length >= 3) {
          this.completePolygon();
        }
      });
    }

    this.tempVertexMarkers.push(marker);

    // Update connecting polyline
    if (!this.tempPolyline) {
      this.tempPolyline = L.polyline(newPoints, {
        color: '#4f46e5',
        weight: 2.5,
        opacity: 0.9,
      }).addTo(this.tempDrawLayer);
    } else {
      this.tempPolyline.setLatLngs(newPoints);
    }
  }

  private onMapDblClick(e: L.LeafletMouseEvent): void {
    if (this.drawMode() === 'polygon' && this.polygonVertices().length >= 3) {
      L.DomEvent.stopPropagation(e);
      this.completePolygon();
    }
  }

  /** Complete the custom polygon drawing and submit to spatial query. */
  protected completePolygon(): void {
    const points = this.polygonVertices();
    if (points.length < 3) return;

    const ringCoords = points.map((p) => [p.lng, p.lat] as [number, number]);
    ringCoords.push([points[0].lng, points[0].lat]); // Close the ring

    const geojson: GeoJsonPolygon = {
      type: 'Polygon',
      coordinates: [ringCoords],
    };

    this.resolveGeometry(geojson);
  }

  protected resolveGeometry(geometry: GeoJsonPolygon): void {
    if (!geometry.coordinates[0] || geometry.coordinates[0].length < 4) {
      this.spatialMessage.set('Hình học vùng chọn không hợp lệ.');
      return;
    }
    this.cancelActiveTool();
    this.drawMode.set('none');
    this.uxState.set('querying');
    this.currentGeometry = geometry;
    this.hasBoundary.set(true);
    this.drawSelectionBoundary(geometry);
    this.spatialLoading.set(true);
    this.spatialMessage.set('');
    this.gisApi.spatialQuery({ geometry }).pipe(
      takeUntilDestroyed(this.destroyRef),
      finalize(() => this.spatialLoading.set(false)),
    ).subscribe({
      next: (assets) => {
        const uniqueAssets = assets.filter((asset, index, list) => list.findIndex((item) => item.assetId === asset.assetId) === index);
        this.spatialAssets.set(uniqueAssets);
        this.uxState.set(uniqueAssets.length ? 'success' : 'empty');
        this.spatialMessage.set(uniqueAssets.length ? '' : 'Không có tài sản trong vùng này.');
        this.renderSpatialAssets();
      },
      error: (error: unknown) => {
        const status = error instanceof Object && 'status' in error ? Number(error.status) : 0;
        this.uxState.set('error');
        this.spatialMessage.set(status === 401 || status === 403 ? 'Bạn không có quyền truy vấn tài sản trong vùng này.' : 'Không thể truy vấn tài sản trong vùng.');
      },
    });
  }

  /** Open the existing inspection UI / drawer for a candidate asset. */
  protected inspectAsset(asset: SelectableAsset): void {
    const tower = this.towers().find((t) => t.id === asset.assetId || t.towerCode === asset.code) ?? {
      id: asset.assetId,
      lineAssetId: '',
      towerCode: asset.code,
      latitude: asset.latitude,
      longitude: asset.longitude,

    };
    this.selectedEntity.set({ type: 'tower', data: tower });
  }

  private drawSelectionBoundary(geometry: GeoJsonPolygon): void {
    if (!this.map) return;
    this.selectionBoundary?.remove();
    const points = geometry.coordinates[0].map(([lng, lat]) => [lat, lng] as L.LatLngTuple);
    this.selectionBoundary = L.polygon(points, {
      color: '#4f46e5',
      weight: 2.5,
      fillColor: '#6366f1',
      fillOpacity: 0.14,
      dashArray: '6 4',
    }).addTo(this.map);
    this.editableLayers.clearLayers();
    this.editableLayers.addLayer(this.selectionBoundary);
    this.hasBoundary.set(true);
  }

  private queryLayer(layer: L.Polygon | L.Rectangle): void {
    const geoJson = layer.toGeoJSON().geometry;
    if (geoJson.type !== 'Polygon') return;
    this.resolveGeometry({ type: 'Polygon', coordinates: geoJson.coordinates as unknown as GeoJsonPolygon['coordinates'] });
  }

  protected startEditing(): void {
    if (!this.hasBoundary()) return;
    this.cancelActiveTool();
    this.uxState.set('editing');
    if (!this.map) return;
    this.editHandler = new L.EditToolbar.Edit(this.map as unknown as L.DrawMap, {
      featureGroup: this.editableLayers,
      selectedPathOptions: { color: '#4338ca', weight: 3, fillOpacity: 0.18, dashArray: undefined },
    });
    this.editHandler.enable();
  }

  protected finishEditing(): void {
    if (!this.editHandler) return;
    this.editHandler.save();
    this.editHandler.disable();
    this.editHandler = null;
  }

  protected onEditCompleted(): void {
    const layer = this.editableLayers.getLayers()[0];
    if (layer instanceof L.Polygon) this.queryLayer(layer);
  }

  protected completeEditedGeometry(geometry: GeoJsonPolygon): void {
    this.resolveGeometry(geometry);
  }

  protected retrySpatialQuery(): void {
    if (this.currentGeometry) this.resolveGeometry(this.currentGeometry);
  }

  protected createMission(): void {
    if (this.targetSelection.count()) void this.router.navigate(['/missions/new']);
  }

  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && (this.drawMode() !== 'none' || this.uxState() === 'editing')) this.cancelActiveTool();
  }

  protected cancelActiveTool(): void {
    // Reset Custom Drawing State
    this.isRectDragging = false;
    this.rectStartLatLng = null;
    this.tempRect?.remove();
    this.tempRect = null;
    this.tempPolyline?.remove();
    this.tempPolyline = null;
    this.tempRubberband?.remove();
    this.tempRubberband = null;
    this.tempVertexMarkers.forEach((m) => m.remove());
    this.tempVertexMarkers = [];
    this.polygonVertices.set([]);
    this.tempDrawLayer.clearLayers();

    if (this.map) {
      this.map.dragging.enable();
      this.map.doubleClickZoom.enable();
    }

    this.editHandler?.revertLayers();
    this.editHandler?.disable();
    this.editHandler = null;
    this.drawMode.set('none');

    if (this.spatialAssets().length) {
      this.uxState.set('success');
    } else if (this.hasBoundary()) {
      this.uxState.set('empty');
    } else if (this.showSelectionPopup()) {
      this.uxState.set('choosing');
    } else {
      this.uxState.set('idle');
    }
  }

  protected clearBoundary(): void {
    this.cancelActiveTool();
    this.editableLayers.clearLayers();
    this.selectionBoundary?.remove();
    this.selectionBoundary = null;
    this.currentGeometry = null;
    this.hasBoundary.set(false);
    this.spatialAssets.set([]);
    this.selectionResultsLayer.clearLayers();
    this.renderConfirmedTargetMarkers();
    this.spatialMessage.set('');
    this.uxState.set(this.showSelectionPopup() ? 'choosing' : 'idle');
  }

  protected renderSpatialAssets(): void {
    this.selectionResultsLayer.clearLayers();
    this.spatialAssets().forEach((asset) => {
      const selected = this.targetSelection.has(asset.assetId);
      const marker = L.circleMarker([asset.latitude, asset.longitude], {
        radius: 8, color: selected ? '#15803d' : '#7c3aed', fillColor: selected ? '#22c55e' : '#a78bfa', fillOpacity: 0.9,
      });
      marker.bindTooltip(`<strong>${asset.code}</strong><br>${asset.name}`);
      marker.on('click', () => { this.toggleAsset(asset); });
      this.selectionResultsLayer.addLayer(marker);
    });
    this.renderConfirmedTargetMarkers();
  }

  private renderConfirmedTargetMarkers(): void {
    this.confirmedTargetsLayer.clearLayers();
    this.targetSelection.selected().forEach((asset) => {
      const icon = L.divIcon({ className: 'confirmed-target-marker', html: '<span>✓</span>', iconSize: [24, 24], iconAnchor: [12, 12] });
      L.marker([asset.latitude, asset.longitude], { icon, zIndexOffset: 900 })
        .bindTooltip(`<strong>Đã chọn: ${asset.code}</strong><br>${asset.name}`)
        .addTo(this.confirmedTargetsLayer);
    });
  }

  protected toggleAsset(asset: SelectableAsset): void {
    if (this.targetSelection.has(asset.assetId)) this.targetSelection.remove(asset.assetId);
    else this.targetSelection.add(asset);
    this.renderSpatialAssets();
  }

  protected addAllSpatialAssets(): void {
    this.targetSelection.addMany(this.spatialAssets());
    this.renderSpatialAssets();
  }

  protected setMapType(type: MapType): void {
    if (!this.map) return;
    this.currentMapType.set(type);

    if (this.currentTileLayer) {
      this.map.removeLayer(this.currentTileLayer);
      this.currentTileLayer = null;
    }

    let tileUrl: string;
    let maxZoom = 20;
    let subdomains: string[] = ['mt0', 'mt1', 'mt2', 'mt3'];
    let attribution = '© Google Maps | UAV-PMS Power Grid GIS';

    switch (type) {
      case 'google-streets':
        tileUrl = 'https://{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}';
        break;
      case 'google-hybrid':
        tileUrl = 'https://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}';
        break;
      case 'google-terrain':
        tileUrl = 'https://{s}.google.com/vt/lyrs=p&x={x}&y={y}&z={z}';
        break;
      case 'osm':
      default:
        tileUrl = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
        subdomains = ['a', 'b', 'c'];
        maxZoom = 19;
        attribution = '© OpenStreetMap contributors | UAV-PMS Power Grid GIS';
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

    this.currentTileLayer.addTo(this.map);
  }

  protected loadGisData(): void {
    this.loading.set(true);
    this.error.set('');

    this.towers.set([]);
    this.lines.set([]);
    this.anomalies.set([]);
    this.alerts.set([]);
    this.selectedEntity.set(null);
    this.targetSelection.clear();
    this.clearBoundary();
    this.renderAllLayers();
    this.gisApi.getAllGisData()
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.loading.set(false)),
      )
      .subscribe({
        next: (data) => {
          this.towers.set(data.towers);
          this.lines.set(data.lines);
          this.anomalies.set(data.anomalies);
          this.alerts.set(data.alerts);

          this.renderAllLayers();
          this.loadMissionsData();
        },
        error: (error: unknown) => {
          console.error('[GIS API load error]:', error);
          const status = error instanceof Object && 'status' in error ? Number(error.status) : 0;
          this.error.set(status === 403 ? '403 — Bạn không có quyền xem dữ liệu GIS.' : 'Không thể tải dữ liệu GIS. Vui lòng thử lại.');
          this.towers.set([]);
          this.lines.set([]);
          this.anomalies.set([]);
          this.alerts.set([]);
          this.missions.set([]);
          this.renderAllLayers();
        },
      });
  }

  private renderAllLayers(): void {
    this.renderTransmissionLines();
    this.renderTowers();
    this.renderDefects();
    this.renderAlerts();
    this.renderMissions();
  }

  private renderTransmissionLines(): void {
    this.linesLayer.clearLayers();
    if (!this.showLinesLayer()) return;

    this.lines().forEach((line) => {
      const is500kV = line.voltage.includes('500');
      const coords = line.coordinates as unknown as L.LatLngExpression[];
      const polyline = L.polyline(coords, {
        color: is500kV ? '#dc2626' : '#0284c7',
        weight: is500kV ? 5 : 4,
        opacity: 0.9,
        dashArray: is500kV ? '10, 5' : undefined,
      });

      polyline.bindTooltip(
        `<div style="font-weight: 700; font-size: 13px;">${line.lineName}</div><div style="font-size: 11px; color: #64748b;">Cấp điện áp: ${line.voltage}</div>`,
        { sticky: true },
      );

      this.linesLayer.addLayer(polyline);
    });
  }

  private renderTowers(): void {
    this.towersLayer.clearLayers();
    if (!this.showTowersLayer()) return;

    this.towers().forEach((tower) => {
      const icon = L.divIcon({
        className: 'custom-tower-marker',
        html: `<span class="tower-label" style="font-size: 11px; font-weight: 800;">⚡</span>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15],
      });

      const marker = L.marker([tower.latitude, tower.longitude], { icon });
      marker.on('click', () => {
        this.selectedEntity.set({ type: 'tower', data: tower });
        this.targetSelection.add({ assetId: tower.id, code: tower.towerCode, name: tower.towerCode, latitude: tower.latitude, longitude: tower.longitude, status: 'Operational' });
        this.renderSpatialAssets();
      });

      marker.bindTooltip(
        `<div style="font-weight: 700; font-size: 13px;">${tower.towerCode}</div><div style="font-size: 11px; color: #64748b;">${tower.transmissionLineName || ''}</div>`,
        { direction: 'top', offset: [0, -10] },
      );

      this.towersLayer.addLayer(marker);
    });
  }

  private renderDefects(): void {
    this.defectsLayer.clearLayers();
    if (!this.showDefectsLayer()) return;

    const defects = this.filteredAnomalies();
    defects.forEach((defect) => {
      const sevClass = defect.severity >= 5 ? 'sev-critical' : defect.severity >= 4 ? 'sev-high' : 'sev-med';
      const icon = L.divIcon({
        className: `custom-defect-marker ${sevClass}`,
        html: `<span>!</span>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });

      const marker = L.marker([defect.latitude, defect.longitude], { icon });
      marker.on('click', () => {
        this.selectedEntity.set({ type: 'anomaly', data: defect });
      });

      marker.bindTooltip(
        `<div style="font-weight: 700; color: #dc2626;">⚠️ ${defect.category}</div><div style="font-size: 11px;">Mức độ: Cấp ${defect.severity}/5 (${defect.confidenceScore}% AI)</div>`,
        { direction: 'top', offset: [0, -10] },
      );

      this.defectsLayer.addLayer(marker);
    });
  }

  private renderAlerts(): void {
    this.alertsLayer.clearLayers();
    if (!this.showAlertsLayer()) return;

    this.alerts().forEach((alert) => {
      const icon = L.divIcon({
        className: 'custom-alert-marker',
        html: `<span>🔥</span>`,
        iconSize: [34, 34],
        iconAnchor: [17, 17],
      });

      const marker = L.marker([alert.latitude, alert.longitude], { icon, zIndexOffset: 1000 });
      marker.on('click', () => {
        this.selectedEntity.set({ type: 'alert', data: alert });
      });

      marker.bindTooltip(
        `<div style="font-weight: 800; color: #dc2626;">🔥 ${alert.title}</div><div style="font-size: 11px;">Ưu tiên: ${alert.priority}</div>`,
        { direction: 'top', offset: [0, -14] },
      );

      this.alertsLayer.addLayer(marker);
    });
  }

  protected loadMissionsData(): void {
    if (!this.canViewMissions()) {
      this.missions.set([]);
      this.renderMissions();
      return;
    }

    const role = (this.auth.user()?.role || '').toLowerCase();
    const isInspector = role === 'inspector' || role === 'pilot';

    this.missionsLoading.set(true);
    this.missionsError.set('');

    const query$: Observable<readonly Mission[]> = isInspector
      ? this.missionsApi.getMyMissions()
      : this.missionsApi.list({ page: 1, pageSize: 100 }).pipe(
          map((page) => page.items),
        );

    query$
      .pipe(
        takeUntilDestroyed(this.destroyRef),
        finalize(() => this.missionsLoading.set(false)),
      )
      .subscribe({
        next: (items: readonly Mission[]) => {
          this.missions.set(items);
          this.renderMissions();
        },
        error: () => {
          this.missionsError.set('Không thể tải dữ liệu nhiệm vụ bay.');
          this.missions.set([]);
          this.renderMissions();
        },
      });
  }

  protected renderMissions(): void {
    this.missionsLayer.clearLayers();
    if (!this.showMissionsLayer() || !this.canViewMissions()) return;

    const allMissions = this.missions();
    const includeCompleted = this.includeCompletedMissions();

    // Filter missions based on status
    const visibleMissions = allMissions.filter((m) => {
      const norm = (m.status || '').toLowerCase().replace(/\s+/g, '');
      if (norm === 'completed') {
        return includeCompleted;
      }
      return true;
    });

    // Group missions by target asset/tower coordinates to avoid unreadable overlapping markers
    const clusterMap = new Map<string, { key: string; towerCode: string; lat: number; lng: number; missions: Mission[] }>();

    visibleMissions.forEach((mission) => {
      // Find targets in mission
      if (mission.targets && mission.targets.length > 0) {
        mission.targets.forEach((target) => {
          // If target has latitude & longitude, use directly; otherwise match with towers list
          let lat = target.latitude;
          let lng = target.longitude;
          const towerCode = target.towerCode || target.assetCode || '';

          if ((lat === undefined || lng === undefined || lat === 0) && towerCode) {
            const tower = this.towers().find((t) => t.towerCode.toLowerCase() === towerCode.toLowerCase() || t.id === target.assetId);
            if (tower) {
              lat = tower.latitude;
              lng = tower.longitude;
            }
          }

          if (lat !== undefined && lng !== undefined && Number.isFinite(lat) && Number.isFinite(lng) && lat !== 0) {
            const clusterKey = `${lat.toFixed(5)}_${lng.toFixed(5)}`;
            const existing = clusterMap.get(clusterKey);
            if (existing) {
              if (!existing.missions.some((m) => m.id === mission.id)) {
                existing.missions.push(mission);
              }
            } else {
              clusterMap.set(clusterKey, {
                key: clusterKey,
                towerCode: towerCode || 'Mục tiêu',
                lat,
                lng,
                missions: [mission],
              });
            }
          }
        });
      }
    });

    clusterMap.forEach((cluster) => {
      const count = cluster.missions.length;
      // Determine dominant state among missions in cluster
      const hasInProgress = cluster.missions.some((m) => this.isMissionInProgress(m.status));
      const hasPlanned = cluster.missions.some((m) => this.isMissionPlanned(m.status));
      const allCompleted = cluster.missions.every((m) => (m.status || '').toLowerCase() === 'completed');

      const stateClass = hasInProgress
        ? 'state-inprogress'
        : hasPlanned
        ? 'state-planned'
        : allCompleted
        ? 'state-completed'
        : 'state-other';

      const label = count > 1 ? `${count}` : '1';

      const icon = L.divIcon({
        className: `custom-mission-badge ${stateClass}`,
        html: `<span class="badge-num">${label}</span>`,
        iconSize: [28, 28],
        iconAnchor: [14, 14],
      });

      const marker = L.marker([cluster.lat, cluster.lng], { icon, zIndexOffset: 950 });

      // Click opens compact popup or detail drawer
      marker.on('click', () => {
        this.selectedEntity.set({
          type: 'missionCluster',
          data: {
            assetKey: cluster.key,
            towerCode: cluster.towerCode,
            latitude: cluster.lat,
            longitude: cluster.lng,
            missions: cluster.missions,
          },
        });
      });

      const summaryTitle = count > 1 ? `${count} Nhiệm vụ tại ${cluster.towerCode}` : `${cluster.missions[0]?.title || 'Nhiệm vụ'} (${cluster.towerCode})`;
      const summaryStatus = cluster.missions.map((m) => this.missionStatusLabel(m.status)).join(', ');

      marker.bindTooltip(
        `<div style="font-weight: 700; font-size: 12px; color: #1e293b;">📋 ${summaryTitle}</div><div style="font-size: 11px; color: #64748b;">Trạng thái: ${summaryStatus}</div>`,
        { direction: 'top', offset: [0, -12] },
      );

      this.missionsLayer.addLayer(marker);
    });
  }

  protected isMissionInProgress(status: string): boolean {
    const norm = (status || '').toLowerCase().replace(/\s+/g, '');
    return norm === 'inprogress' || norm === 'executing' || norm === 'running';
  }

  protected isMissionPlanned(status: string): boolean {
    const norm = (status || '').toLowerCase().replace(/\s+/g, '');
    return norm === 'pending' || norm === 'planned' || norm === 'scheduled';
  }

  protected missionStatusLabel(status: string): string {
    const norm = (status || '').toLowerCase().replace(/\s+/g, '');
    if (norm === 'pending' || norm === 'planned' || norm === 'scheduled') return 'Đã lên lịch';
    if (norm === 'inprogress' || norm === 'executing' || norm === 'running') return 'Đang thực hiện';
    if (norm === 'completed') return 'Đã hoàn thành';
    if (norm === 'failed') return 'Thất bại';
    if (norm === 'cancelled') return 'Đã hủy';
    return status || 'Chờ xử lý';
  }

  protected missionStatusClass(status: string): string {
    if (this.isMissionInProgress(status)) return 'inprogress';
    if (this.isMissionPlanned(status)) return 'planned';
    if ((status || '').toLowerCase() === 'completed') return 'completed';
    return 'other';
  }

  protected applyFilters(): void {
    this.renderDefects();
    this.renderMissions();
  }

  protected resetFilters(): void {
    this.searchCode.set('');
    this.severityFilter.set('');
    this.statusFilter.set('');
    this.includeCompletedMissions.set(false);
    this.renderDefects();
    this.renderMissions();
  }

  protected toggleLayer(type: 'towers' | 'lines' | 'defects' | 'alerts' | 'missions'): void {
    if (type === 'towers') {
      this.showTowersLayer.update((v) => !v);
      this.renderTowers();
    } else if (type === 'lines') {
      this.showLinesLayer.update((v) => !v);
      this.renderTransmissionLines();
    } else if (type === 'defects') {
      this.showDefectsLayer.update((v) => !v);
      this.renderDefects();
    } else if (type === 'alerts') {
      this.showAlertsLayer.update((v) => !v);
      this.renderAlerts();
    } else if (type === 'missions') {
      this.showMissionsLayer.update((v) => !v);
      this.renderMissions();
    }
  }

  protected fitMapBounds(): void {
    if (!this.map) return;
    this.map.fitBounds(L.latLngBounds([8.15, 102.0], [23.5, 110.0]));
  }

  protected closeDrawer(): void {
    this.selectedEntity.set(null);
  }

  protected navigateToReview(anomalyId: string): void {
    void this.router.navigate(['/ai-review', anomalyId]);
  }

  protected navigateToMission(missionId: string): void {
    void this.router.navigate(['/missions', missionId]);
  }
}
