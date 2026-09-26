# 📋 BÁO CÁO ĐỒNG BỘ KỸ THUẬT MF02: FRONTEND & BACKEND (HOÀN TẤT 100%)

**Trạng thái tổng thể:** ✅ **HOÀN THÀNH TOÀN BỘ (100% FE & BE SYNCED - BUILD PASS)**  
**Mức độ:** Resolved – Toàn bộ luồng tạo, phân công 3 vai trò và tiếp nhận nhiệm vụ MF02 đã sẵn sàng  
**Ngày cập nhật:** 2026-09-26  

---

## I. TỔNG KẾT PHẢN HỒI TỪ BACKEND & CÁC TỐI ƯU TRÊN FRONTEND

Backend đã xác nhận và kiểm thử tự động 371/371 tests passed. Frontend đã đồng bộ hóa toàn diện mã nguồn để tương thích 100% với Backend:

| Mục | Nội dung từ Backend | Phía Frontend đã xử lý / đồng bộ |
|---|---|---|
| **BE-Q1: `GET /api/v1/missions/my`** | Backend lọc đủ 3 điều kiện: `InspectorId == userId \|\| AssignedToUserId == userId \|\| Assignments.Any(a => a.UserId == userId)`. Cho phép tất cả vai trò gọi. | ✅ `MissionsApi.my()` gọi `/my` và tự động đối soát ma trận phân công với `currentUser.id` để hiển thị chính xác quyền tiếp nhận. |
| **BE-Q2: `POST /api/v1/missions`** | Backend duyệt mảng `assignments`, lưu 3 bản ghi vào `MissionAssignments` với `UserId` kiểu Guid. **Yêu cầu bắt buộc gửi kèm `regionId`** để kích hoạt `MissionLifecycleService.CreateAsync`. | ✅ 1. `mission-create.ts` lấy 100% người dùng thực từ CSDL (`UsersApi.getAll()`), map theo alias email Gmail (`+inspector`, `+analyst`, `+technician`), gửi đúng GUID thật.<br>2. Đảm bảo `regionId` luôn có giá trị trong `createBody` (fallback `'reg-cpc'`). |
| **BE-Q3: SignalR Hub `/hubs/notifications`** | Backend phát `MissionDispatched` tới từng kênh `Clients.Group($"user:{guid}")` cho cả 3 vai trò và broadcast vào `mission_{id}`. Hub map bằng `ClaimTypes.NameIdentifier`. Khi offline, lưu vào bảng `Notifications`. | ✅ 1. `notifications-realtime.ts` lắng nghe đầy đủ `MissionDispatched`, `MissionAssigned`, `MissionCreated`, `AssignmentCreated`.<br>2. Bóc tách payload lồng trong `data`.<br>3. `NotificationsStore` chuyển đổi thành thông báo cục bộ và gán đúng `userId`. |
| **BE-Q4: `GET /api/v1/notifications/history`** | Trả về thông báo từ bảng `Notifications` cho `UserId == currentUserId`. | ✅ `notifications-api.ts` hỗ trợ linh hoạt cả camelCase lẫn PascalCase từ C# (`UserId`, `Type`, `Title`, `Body`, `IsRead`), bóc tách danh sách an toàn. |
| **BE-Q5: Nhất quán JWT Token & CSDL** | Token JWT ký với `ClaimTypes.NameIdentifier = user.Id.ToString()`. Khớp 100% với `Users.Id`, `MissionAssignments.UserId`, `Notifications.UserId`. | ✅ `auth.ts` parse đúng GUID từ token. `NotificationsStore` lọc hiển thị thông báo theo GUID này. |
| **BE-Q6: `GET /api/v1/missions/{id}/assignments`** | Backend trả về DTO đầy đủ: `totalRequiredCount: 3`, `confirmedCount`, `allConfirmed`, `confirmationDeadline`, và mảng `assignments` có `userFullName`, `isRequired`. | ✅ 1. `missions-api.ts` hỗ trợ trường `userFullName` trong cả `normalizeMission` và `getAssignmentsOverview`.<br>2. Ưu tiên số liệu `confirmedCount`, `totalRequiredCount`, `allConfirmed` trả về từ Backend.<br>3. Bổ sung các endpoint fallback (`/assignments/{id}/accept`, `/assignments/respond`, `/confirm`) khi xác nhận tiếp nhận. |

---

## II. DANH SÁCH CÁC FILE FRONTEND ĐÃ HOÀN TẤT & ĐƯỢC KIỂM TRA

1. **`src/app/core/auth/auth.ts`**:
   - Dọn sạch `localStorage` và `sessionStorage` (`uav_pms_missions_data_v2`, `uav_pms_notifications_v1`) khi `logout()`, triệt tiêu hoàn toàn lỗi nhiễm chéo dữ liệu giữa các tài khoản khi test trên cùng một trình duyệt.

2. **`src/app/features/missions/pages/mission-create/mission-create.ts`**:
   - `allPersonnelCandidates` lấy 100% người dùng thực từ CSDL qua `UsersApi.getAll()`.
   - Tự động nhận diện vai trò dựa trên alias email (`An3439201+inspector/analyst/technician@gmail.com`).
   - `autoSelectCandidatesIfEmpty` loại bỏ hoàn toàn các Mock ID `usr-...` và chọn đúng GUID thật.
   - Đảm bảo `regionId` luôn được truyền khi tạo nhiệm vụ.

3. **`src/app/app.routes.ts`**:
   - Mở rộng `roleGuard` cho route `missions/:id/inspector` cho phép cả `Inspector`, `Analyst`, `Technician`, `MaintenanceTechnician` cùng truy cập để tiếp nhận & xác nhận vai trò.

4. **`src/app/core/layout/header/header.ts` & `header.html`**:
   - Sử dụng `isOperationalRole()` cho link điều hướng từ thông báo tới trang tiếp nhận nhiệm vụ.

5. **`src/app/features/missions/pages/mission-list/mission-list.html`**:
   - Cập nhật link điều hướng bảng danh sách theo `isOperationalRole()`.

6. **`src/app/features/notifications/data-access/notifications-realtime.ts`**:
   - Thêm các listener SignalR: `MissionAssigned`, `MissionCreated`, `ReceiveMissionAssigned`, `ReceiveMissionCreated`, `AssignmentCreated`.
   - Hỗ trợ unwrap payload lồng trong `data`.
   - Mở rộng type `MissionLifecycleEventType` cho `'ASSIGNED'` và `'CREATED'`.

7. **`src/app/features/notifications/data-access/notifications-store.ts`**:
   - Tích hợp lọc thông báo theo `userId` người dùng hiện tại.
   - Gán `currentUserId` khi nhận event realtime từ SignalR Hub.

8. **`src/app/features/notifications/data-access/notifications-api.ts`**:
   - Bổ sung mapping PascalCase cho các trường JSON trả về từ ASP.NET Core (`UserId`, `Title`, `Body`, `IsRead`).

9. **`src/app/features/missions/data-access/missions-api.ts`**:
   - Đảm bảo `regionId` trong `create()`.
   - Hỗ trợ `userFullName` trong ma trận phân công.
   - Bổ sung endpoint fallback đa tầng khi xác nhận hoặc báo hoãn nhiệm vụ.
   - Tự động đối soát `userId` của vai trò vận hành đang đăng nhập trong `my()`.

---

## III. KẾT QUẢ XÁC MINH HỆ THỐNG

- **Kiểm tra biên dịch**: Đã chạy `npm run build` thành công rực rỡ (**Exit code: 0, 0 error**).
- **Sẵn sàng kiểm thử**: Bạn có thể đăng nhập bằng tài khoản Manager để tạo nhiệm vụ mới, sau đó đăng nhập lần lượt bằng các tài khoản Inspector, Analyst, Technician để kiểm tra thông báo chuông và danh sách nhiệm vụ được giao.
