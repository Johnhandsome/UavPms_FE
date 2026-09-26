  # 📋 BACKEND GITHUB ISSUE: TÁI CẤU TRÚC TRẠNG THÁI ĐÁNH GIÁ TIỀN BAY MF01 (PRE-MISSION ASSESSMENT)

  > **Mục đích**: Tài liệu đặc tả Issue kỹ thuật để chuyển giao cho đội ngũ Backend (ASP.NET Core / EF Core / SQL Server / PostgreSQL).  
  > **Frontend Status**: Đã hoàn thành chuẩn hóa mô hình trạng thái trên Angular frontend.  
  > **Mức độ ưu tiên (Priority)**: 🟡 **Trung bình - Cao (Đồng bộ mô hình dữ liệu và API schema)**.

  ---

  ## 📌 Tiêu đề Issue (Title)
  `[Backend/Refactor] Chuẩn hóa Trạng thái MF01: Đổi CONSUMED thành COMPLETED, Gộp INCOMPLETE vào NOT_READY`

  **Labels**: `backend`, `refactor`, `database`, `migration`, `MF01`, `API`

  ---

  ## 1. Bối cảnh & Mục tiêu (Context & Objective)

  Trong quy trình thẩm định an toàn sẵn sàng tiền bay (**MF01 - Pre-Mission Readiness Assessment**), hệ thống cần tinh gọn và chuẩn hóa lại danh mục trạng thái vòng đời của hồ sơ đánh giá:

  1. **Thay thế `CONSUMED` bằng `COMPLETED`**:
    - *Lý do*: Thuật ngữ `CONSUMED` (đã tiêu thụ) mang tính kỹ thuật nội bộ, gây khó hiểu cho người dùng và các hệ thống tích hợp bên ngoài. 
    - *Mục tiêu*: Chuyển đổi tên trạng thái thành **`COMPLETED`** (Đã hoàn thành) để thể hiện rõ ràng rằng hồ sơ thẩm định đã hoàn tất đầy đủ 4 trụ cột và đã được chuyển tiếp tạo thành công Nhiệm vụ bay (MF02). Loại bỏ hoàn toàn trạng thái `CONSUMED`.

  2. **Gộp `INCOMPLETE` vào `NOT_READY`**:
    - *Lý do*: Việc tách riêng `INCOMPLETE` (chưa hoàn tất dữ liệu) và `NOT_READY` (chưa sẵn sàng) gây dư thừa trạng thái và làm phức tạp bộ lọc điều kiện. Về bản chất nghiệp vụ bay, bất kỳ hồ sơ nào chưa đủ điều kiện cất cánh (dù do thiếu thông tin chẩn đoán hay do vi phạm an toàn) đều thuộc nhóm **"Chưa sẵn sàng bay (NOT_READY)"**.
    - *Mục tiêu*: Loại bỏ trạng thái `INCOMPLETE`. Mọi trường hợp thiếu dữ liệu chẩn đoán kỹ thuật, chưa đủ thông tin nhân sự/UAV hoặc vi phạm an toàn đều chuyển về **`NOT_READY`**.

  ---

  ## 2. Danh mục Trạng thái Chuẩn hóa Mới (New Assessment Status Schema)

  Hồ sơ đánh giá tiền bay MF01 chỉ còn 7 trạng thái chính thức:

  | Mã trạng thái mới | Tên tiếng Việt | Nhóm hiển thị | Mô tả nghiệp vụ |
  | :--- | :--- | :--- | :--- |
  | **`DRAFT`** | Bản nháp | Info / Khởi tạo | Đang tạo hồ sơ, chọn tuyến đường dây và ứng viên. |
  | **`EVALUATING`** | Đang đánh giá | Info / Đang xử lý | Hệ thống đang chạy thuật toán kiểm tra tính khả thi và xung đột. |
  | **`READY`** | Sẵn sàng | Success / Đạt chuẩn | Cả 4 trụ cột đều đạt. Mở khóa nút tạo nhiệm vụ bay. |
  | **`NOT_READY`** | Chưa sẵn sàng | Danger / Không đạt | Vi phạm an toàn, có xung đột tài nguyên **hoặc chưa hoàn tất dữ liệu**. *(Đã gộp INCOMPLETE vào đây)*. |
  | **`EXPIRED`** | Hết hạn | Danger / Quá hạn | Quá thời hạn hiệu lực (`validUntil`). Cần đánh giá lại. |
  | **`COMPLETED`** | Đã hoàn thành | Success / Hoàn tất | Đã chuyển tiếp tạo thành công nhiệm vụ bay MF02. *(Thay thế cho CONSUMED)*. |
  | **`CANCELLED`** | Đã hủy | Neutral / Đã hủy | Hồ sơ bị hủy bỏ bởi người dùng hoặc quản lý. |

  ---

  ## 3. Kế hoạch Di chuyển Cơ sở Dữ liệu (Database Migration Plan)

  ### 3.1. Cập nhật Constraint / Enum

  #### Đối với PostgreSQL:
  ```sql
  -- Bước 1: Thêm giá trị mới 'COMPLETED' nếu sử dụng PostgreSQL ENUM
  ALTER TYPE assessment_status_enum ADD VALUE IF NOT EXISTS 'COMPLETED';

  -- Bước 2: Chuyển đổi dữ liệu các bản ghi cũ
  UPDATE pre_mission_assessments 
  SET status = 'COMPLETED' 
  WHERE status = 'CONSUMED';

  UPDATE pre_mission_assessments 
  SET status = 'NOT_READY' 
  WHERE status = 'INCOMPLETE';
  ```

  #### Đối với SQL Server / MySQL (dùng Check Constraint hoặc nvarchar):
  ```sql
  -- Bước 1: Cập nhật dữ liệu cũ trước khi đổi ràng buộc
  UPDATE pre_mission_assessments 
  SET status = 'COMPLETED' 
  WHERE status = 'CONSUMED';

  UPDATE pre_mission_assessments 
  SET status = 'NOT_READY' 
  WHERE status = 'INCOMPLETE';

  -- Bước 2: Cập nhật Check Constraint
  ALTER TABLE pre_mission_assessments DROP CONSTRAINT IF EXISTS chk_assessment_status;

  ALTER TABLE pre_mission_assessments ADD CONSTRAINT chk_assessment_status 
    CHECK (status IN ('DRAFT', 'EVALUATING', 'READY', 'NOT_READY', 'EXPIRED', 'COMPLETED', 'CANCELLED'));
  ```

  ---

  ## 4. Cập nhật Mã nguồn Backend (C# / ASP.NET Core)

  ### 4.1. Cập nhật Enum `AssessmentStatus`
  File: `Domain/Enums/AssessmentStatus.cs` (hoặc tương đương):

  ```csharp
  namespace UavPms.Domain.Enums
  {
      public enum AssessmentStatus
      {
          Draft,
          Evaluating,
          Ready,
          NotReady,
          Expired,
          Completed,   // Thay thế cho Consumed
          Cancelled
      }
  }
  ```

  ### 4.2. Cập nhật Logic Đánh giá Khả thi (Evaluation Service)
  Trong service thẩm định tính sẵn sàng (`AssessmentEvaluationService.cs`):
  - Nếu thiếu dữ liệu kiểm tra mặt bằng, vi điều khiển BIST hoặc thiếu nhân sự/UAV: Trả về trạng thái `AssessmentStatus.NotReady` kèm lý do cụ thể trong `ReadinessCheck.Reason` (không trả về `Incomplete`).

  ```csharp
  if (!isSitePass || !isPersonnelPass || !isUavPass || !isTechnicalPass)
  {
      assessment.Status = AssessmentStatus.NotReady;
  }
  else
  {
      assessment.Status = AssessmentStatus.Ready;
  }
  ```

  ### 4.3. Cập nhật Endpoint Chuyển tiếp Tạo Nhiệm vụ
  - Thêm hoặc alias endpoint:
    - `POST /api/pre-mission-assessments/{id}/mark-completed`
    - Body: `{ "missionId": "string" }`
    - Logic: Gán `assessment.ConsumedMissionId = missionId; assessment.Status = AssessmentStatus.Completed;`
  - Giữ lại endpoint cũ `POST /api/pre-mission-assessments/{id}/consume` dưới dạng redirect/alias nội bộ để tránh breaking change nếu còn consumer khác gọi vào.

  ### 4.4. Cập nhật Bộ lọc Danh sách (Query Filter)
  - Chấp nhận tham số `status=COMPLETED` và `status=NOT_READY` trong `GET /api/pre-mission-assessments`.
  - Tự động map giá trị query cũ (nếu client cũ gửi `status=CONSUMED` -> chuyển thành `status=COMPLETED`, `status=INCOMPLETE` -> chuyển thành `status=NOT_READY`).

  ---

  ## 5. Kế hoạch Kiểm thử & Nghiệm thu (Acceptance Criteria)

  - [ ] Migration database chạy thành công trên Development và Staging, không gây lỗi bản ghi cũ.
  - [ ] Không còn bản ghi nào có `status = 'CONSUMED'` hoặc `status = 'INCOMPLETE'` trong database.
  - [ ] Gọi API tạo nhiệm vụ từ đánh giá tiền bay: Bản ghi đánh giá chuyển sang `status = 'COMPLETED'`.
  - [ ] Gọi API lọc `GET /api/pre-mission-assessments?status=COMPLETED`: Trả về danh sách các đánh giá đã hoàn thành tạo nhiệm vụ.
  - [ ] Hồ sơ thiếu dữ liệu trả về `status = 'NOT_READY'`.
  - [ ] Không có lỗi 400/500 do enum không hợp lệ.
