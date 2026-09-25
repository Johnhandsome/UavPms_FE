# UAV-PMS Frontend UI Refactor v2.0
## EVN-Inspired Technical Operations Design System

## 1. Version History

| Version | Change |
|---|---|
| **v2.0** | Global frontend visual/UX refactor. All existing UAV-PMS pages should be migrated toward a consistent **EVN-inspired technical management interface** while preserving modern usability, accessibility and responsive behavior. The provided EVN technical-management screenshot is the primary visual reference for density, hierarchy and operational character, not a pixel-perfect legacy clone. |

## 2. Objective

Refactor the **entire frontend**, not only MF01/MF02, so UAV-PMS looks like one coherent electrical-utility operations product.

Visual direction from reference:
- strong blue enterprise header/navigation;
- compact operational layout;
- light-blue/neutral data surfaces;
- bordered data tables;
- dense filters/toolbars;
- clear page/module hierarchy;
- utility-first appearance rather than marketing/SaaS cards.

Modernize:
- spacing;
- typography;
- responsive behavior;
- accessibility;
- semantic status;
- form feedback;
- reusable components;
- loading/empty/error states.

Do not pixel-copy dated controls/icons from the reference.

## 3. Mandatory Refactor Strategy

Before changing pages:

1. Inventory all existing routes/pages.
2. Inventory duplicated layout/table/form/status components.
3. Identify current design tokens and hardcoded colors/spacing.
4. Build shared shell/components.
5. Migrate pages incrementally.
6. Keep route/business behavior intact unless the MF v2 specs explicitly change it.
7. Remove obsolete duplicate UI after migration.

Do not rewrite every page independently.

## 4. Global Application Shell

```text
┌──────────────────────────────────────────────────────────────┐
│ EVNSPC / UAV-PMS      MODULE NAV             USER / REGION   │
├──────────────────────────────────────────────────────────────┤
│ Breadcrumb / submodule navigation     Help / Notifications   │
├──────────────────────────────────────────────────────────────┤
│ Page Title                         Search / Primary Actions   │
├──────────────────────────────────────────────────────────────┤
│ Action Toolbar: Create | Edit | Refresh | Export | ...       │
├──────────────────────────────────────────────────────────────┤
│ Context Filter Bar                                            │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│ Main operational workspace                                   │
│ Table / GIS / Detail / Assessment / Technical Dashboard      │
│                                                              │
├──────────────────────────────────────────────────────────────┤
│ Pagination / record count / secondary status                 │
└──────────────────────────────────────────────────────────────┘
```

## 5. Shared Components

Create/reuse components equivalent to:

```text
AppShell
TopHeader
ModuleNavigation
BreadcrumbBar
PageHeader
ActionToolbar
FilterBar
DataTable
Pagination
StatusBadge
HealthIndicator
SummaryStrip
DetailPanel
FormSection
SearchInput
DateRangeFilter
RegionFilter
ConfirmDialog
ReasonDialog
EmptyState
ErrorState
LoadingState / Skeleton
PermissionDenied
GISPanel
TechnicalMetricTable
NotificationCenter
```

Names may follow the existing framework conventions.

Do not create page-specific copies of generic components.

## 6. Design Tokens

Centralize tokens. Do not scatter literal hex values through pages.

Token categories:

```text
color.brand.primary
color.brand.primaryStrong
color.surface.app
color.surface.panel
color.surface.tableHeader
color.border.default

color.status.success
color.status.warning
color.status.danger
color.status.info
color.status.neutral

space.xs / sm / md / lg / xl
radius.sm / md
shadow.panel
font.size.xs / sm / md / lg / xl
```

The visual family should resemble EVN blue/light-blue technical systems, while maintaining WCAG-friendly contrast.

## 7. Typography and Density

- Use a clean sans-serif UI font already available in the project.
- Dense but readable desktop tables.
- Avoid giant dashboard headings/cards.
- Page title clearly stronger than section headings.
- IDs/codes may use compact/monospace treatment where useful.
- Long Vietnamese labels must wrap gracefully.

## 8. Navigation

Top-level modules should reflect actual product domains, for example:

- Dashboard
- Mission
- Assets / GIS
- UAV / Fleet
- Inspection
- Alerts
- Maintenance
- Reports
- Administration

Only show modules the authenticated user may access.

Use active module and active route states.

Do not invent backend permissions merely to populate navigation.

## 9. Data Table Standard

For operational list pages:

- sticky/clear header where useful;
- column sorting only when supported;
- column filters/search;
- pagination;
- record count;
- row actions;
- selectable rows only when bulk action exists;
- status badges;
- empty/loading/error states;
- horizontal scroll on narrow screens.

Do not make every page a table. Use tables for list/management workflows.

## 10. Filter Standard

Common filter bar pattern:

```text
Region | Line | Status | Date Range | Inspector | UAV | Search
```

Only render filters relevant to that page.

Requirements:
- Reset filters;
- visible active filters;
- debounce free-text search;
- URL query state for list filters where practical;
- server-side filtering for large datasets.

## 11. Status System

Semantic status must be consistent globally.

Examples:

Success:
- READY
- HEALTHY
- AVAILABLE
- ACCEPTED
- COMPLETED

Warning:
- WARNING
- POSTPONED
- INCOMPLETE

Danger:
- CRITICAL
- NOT_READY
- FAILED
- UNAVAILABLE
- EMERGENCY

Info/Active:
- IN_PROGRESS
- EVALUATING
- PENDING

Neutral:
- DRAFT
- UNKNOWN
- CANCELLED where product policy treats it neutral

Never communicate status using color alone. Include text and optionally icon.

## 12. Page-Type Patterns

### 12.1 List / Management Pages
Use:
`PageHeader → Toolbar → Filters → DataTable → Pagination`.

Examples:
- Missions
- UAV Fleet
- Personnel
- Alerts
- Maintenance records

### 12.2 Detail Pages
Use:
`Summary Strip → Primary Actions → Tabs/Sections`.

Avoid displaying 20 unrelated cards.

### 12.3 GIS Pages
Map is primary workspace.

Use collapsible filters/side panel rather than shrinking map into a decorative card.

### 12.4 Technical Inspection
Use subsystem health summary + technical metric table.

Do not represent technical diagnostics as generic text fields.

### 12.5 Workflow / Assessment
Use step/workspace structure with persistent readiness summary.

MF01 is the reference implementation.

## 13. Mission UI

Mission List should expose:
- Mission Code/ID
- Name
- Region / Line
- Planned Time
- Status
- Inspector
- UAV
- Priority
- Actions

Mission Detail:
- summary;
- scope/GIS;
- personnel;
- UAV;
- progress;
- events;
- audit/history where permission allows.

Lifecycle actions must be state-aware.

## 14. UAV / Fleet UI

UAV list must distinguish:
- Operational Status
- Technical Health
- Last Technical Inspection
- Current Mission/Reservation where relevant

UAV detail tabs/sections:
- Overview
- Technical Health
- Inspection History
- Technical Metrics
- Mission History
- Maintenance where supported

Never reduce UAV health to one ambiguous colored dot.

## 15. MF01 Reference Pattern

MF01 should demonstrate:
- assessment workspace;
- GIS/scope;
- personnel readiness (kiểm tra pool ứng viên cho đủ tối thiểu 3 vai trò: Inspector, Analyst, Technician theo 5 tiêu chí bắt buộc: Eligible AND Active AND Within Region/Scope AND Available during proposed time AND Has required role/qualification);
- UAV readiness;
- technical inspection;
- overall readiness (chỉ READY khi cả 4 nhóm đạt PASS);
- validity/expiry;
- clear handoff to MF02.

Use `MF01_v2.0_FE_PreMission_Readiness.md` as behavior source.

## 16. MF02 Reference Pattern

MF02 should demonstrate:
- READY assessment context;
- scope review;
- final personnel assignment cho đủ tối thiểu 3 vai trò (Inspector, Analyst, Technician, mỗi role ≥ 1 người);
- UAV selection;
- mission form & confirmation deadline;
- final revalidation;
- multi-role dispatch & notifications;
- Multi-Role Confirmation Console (Accept / Postpone cho từng role Inspector, Analyst, Technician);
- Aggregate Confirmation Status (Mission chỉ chuyển CONFIRMED khi đủ 100% 3 role Accept);
- Postpone & Reassignment workflow.

Use `MF02_v2.0_FE_Create_Assign_Mission.md` as behavior source.

## 17. Forms

- Persistent labels, not placeholder-only labels.
- Required fields visibly marked.
- Inline validation near field.
- Server errors mapped to field where possible.
- Unsaved-change warning for meaningful forms.
- Date/time displayed in consistent project timezone policy.
- Destructive actions require confirmation.
- Avoid giant modal forms; use pages/drawers for complex workflows.

## 18. GIS

GIS must support project asset hierarchy and mission scope.

Recommended:
- map;
- asset markers/line layers;
- selected-scope visualization;
- legend;
- selection summary;
- authorized-scope filtering;
- loading/error states.

Frontend map filtering does not replace backend authorization.

## 19. Notifications

Provide consistent notification center/toast behavior.

Use toast for transient success/info.

Use persistent inline error for actionable failure.

Do not rely on toast alone for:
- failed form validation;
- assessment NOT_READY;
- resource conflict;
- critical emergency state.

## 20. Error UX

Map backend errors into useful UI.

Examples:
- 401 → auth/session handling;
- 403 → PermissionDenied;
- 404 → NotFound;
- 409 → conflict/stale-resource UI;
- 422/400 → validation;
- 5xx → retryable system error where safe.

Never expose raw stack traces.

## 21. Loading UX

- skeleton for page/detail loading;
- table loading state;
- action-level spinner for mutations;
- disable duplicate action while pending;
- do not block entire application for a small row mutation.

## 22. Empty States

Every empty state should explain:
- what is empty;
- whether filters caused it;
- what authorized action can resolve it.

Example:
“No READY UAV matches the current assessment” is better than “No data”.

## 23. Accessibility

Required:
- keyboard navigation;
- visible focus;
- semantic HTML;
- proper form labels;
- table headers;
- accessible dialog focus trapping;
- status not color-only;
- sufficient contrast;
- meaningful button names/icons with accessible labels.

## 24. Responsive Behavior

Primary target is desktop operations.

Still support:
- laptop widths;
- narrower screens with horizontal table scroll;
- collapsible navigation;
- stacked form sections;
- GIS side panel collapse.

Do not attempt to squeeze a 12-column operations table into unreadable mobile cards unless mobile is an explicit project requirement.

## 25. Performance

- server pagination for large operational lists;
- debounce search;
- lazy-load heavy GIS/technical modules where appropriate;
- avoid fetching full mission/media histories on list pages;
- cancel stale requests;
- memoize only where profiling justifies it.

## 26. FE Architecture / Clean Code

Recommended structure conceptually:

```text
app/
  shell/
features/
  missions/
  pre-mission/
  fleet/
  assets/
  inspections/
  alerts/
  maintenance/
shared/
  components/
  forms/
  table/
  status/
  gis/
  api/
  auth/
  utils/
styles/
  tokens/
```

Adapt to current repository rather than blindly recreating folders.

Rules:
- feature logic stays in feature modules;
- generic UI stays shared;
- API calls go through centralized clients/services;
- no fetch calls scattered through presentation components;
- no hardcoded role checks across random JSX/templates;
- no duplicated enum-label-color maps;
- no business readiness calculations in FE.

## 27. Refactor Safety Rules

Codex/implementer must:

1. Inspect current routes/components before deleting.
2. Preserve working business behavior unless v2 spec changes it.
3. Refactor shared shell first.
4. Migrate one feature/page group at a time.
5. Keep commits/build steps reviewable.
6. Run lint/typecheck/tests after each meaningful migration.
7. Do not replace real API integration with mock data.
8. Do not silently rename backend fields.
9. Do not remove permission checks.
10. Do not introduce new UI framework unless approved.

## 28. Testing

At minimum:
- route rendering;
- permission-based action visibility;
- filter/query behavior;
- table loading/empty/error;
- status rendering;
- form validation;
- 409 conflict UX;
- MF01 → MF02 navigation;
- expired assessment behavior;
- create mission double-submit prevention;
- Accept/Postpone;
- responsive smoke test;
- keyboard/dialog accessibility smoke test.

## 29. Definition of Done

Global UI refactor is complete when:

1. All active pages use one application shell.
2. Shared colors/spacing/status styles come from centralized tokens.
3. Operational list pages follow a consistent table/filter pattern.
4. GIS remains map-first.
5. UAV technical pages expose meaningful technical health.
6. MF01 and MF02 follow their v2 FE specs.
7. Loading/empty/error/permission states exist on all major pages.
8. No duplicated status semantics remain.
9. Existing authorization/business behavior is preserved.
10. Frontend passes project lint/typecheck/tests and is visually consistent with the EVN-inspired technical-management direction.
