import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { environment } from '../../../../environments/environment';
import { MissionsApi } from './missions-api';

describe('MissionsApi', () => {
  it('creates a mission with target asset IDs and parses mission targets', () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const api = TestBed.inject(MissionsApi); const http = TestBed.inject(HttpTestingController);
    const body = { name: 'Inspection', description: '', scheduledAt: '2026-09-03T01:00:00.000Z', inspectorId: 'u1', droneId: 'd1', targetAssetIds: ['a1', 'a2'] };
    let targetName = '';
    api.create(body).subscribe((mission) => targetName = mission.targets[0]?.assetName ?? '');
    const request = http.expectOne(`${environment.apiBaseUrl}/missions`);
    expect(request.request.body.targetAssetIds).toEqual(['a1', 'a2']);
    request.flush({ data: { id: 'm1', name: 'Inspection', missionTargets: [{ assetId: 'a1', assetName: 'Tower 1', sequence: 1, inspectionStatus: 'Pending' }] } });
    expect(targetName).toBe('Tower 1'); http.verify();
  });

  it('fetches inspector missions via getMyMissions() from /missions/my', () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const api = TestBed.inject(MissionsApi);
    const http = TestBed.inject(HttpTestingController);

    let itemsCount = 0;
    api.getMyMissions().subscribe((missions) => itemsCount = missions.length);

    const request = http.expectOne(`${environment.apiBaseUrl}/missions/my`);
    expect(request.request.method).toBe('GET');
    request.flush({
      success: true,
      data: [
        { id: 'm-my-1', missionCode: 'MIS-001', title: 'My Mission 1', status: 'Pending' },
        { id: 'm-my-2', missionCode: 'MIS-002', title: 'My Mission 2', status: 'Executing' },
      ],
    });

    expect(itemsCount).toBe(2);
    http.verify();
  });
});
