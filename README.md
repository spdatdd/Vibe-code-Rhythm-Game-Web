# ORBIT — Rhythm Lab

Game Piano Tiles 3D chạy bằng Node.js, Canvas và Web Audio. Code có comment tiếng Việt.

## Mở game

Nhấp đúp `Start-Game.cmd`, giữ cửa sổ server mở rồi truy cập **http://127.0.0.1:5173/**.
Hoặc chạy `node server.mjs` trong thư mục dự án. Máy chủ chỉ lắng nghe trên máy hiện tại.
Nếu vừa cập nhật server, tắt cửa sổ server cũ bằng Ctrl+C rồi chạy lại.

## Chơi bằng tay cầm

Kết nối USB hoặc Bluetooth rồi bấm một nút để trình duyệt nhận tay cầm. Trong mục **Tay cầm**, chọn từng cột **D, F, J, K** và bấm nút vật lý muốn gán. Game lưu cấu hình theo mẫu tay cầm trong trình duyệt. Tay cầm dùng chung cách chấm điểm với bàn phím và cảm ứng. Khi đánh nốt dài trong demo, giữ nút đến hết đuôi.

## Chạy cả game và phân tích YouTube với Netlify và Render

**Render Free** chạy Node.js, Python và FFmpeg trong Docker. **Netlify Free theo credit** phục vụ giao diện và chuyển các yêu cầu `/api/*` tới Render qua Netlify Server. Repo GitHub có thể giữ riêng tư.

1. Trên [Render Dashboard](https://dashboard.render.com/), chọn **New → Blueprint**. Kết nối repo `spdatdd/Vibe-code-Rhythm-Game-Web`, chọn nhánh `main` (hoặc nhánh trong `render.yaml`) và dùng `render.yaml`. Blueprint tạo một Docker Web Service gói **Free** và tạo ngẫu nhiên khóa `ORBIT_BACKEND_SECRET`.
2. Khi Render báo **Live**, lưu URL HTTPS dạng `https://ten-dich-vu.onrender.com`. Trong phần **Environment** của dịch vụ, lấy giá trị `ORBIT_BACKEND_SECRET` để nhập trực tiếp vào Netlify.
3. Trong Netlify, dùng team **Free** theo credit với mặc định **Private for new projects**. Import cùng repo và nhánh `main`, hoặc mở dự án hiện có. Để trống **Base directory** và **Build command**. `netlify.toml` đã đặt thư mục xuất bản `public` và Node 24.
4. Trong **Project configuration → Environment variables**, đặt `ORBIT_BACKEND_URL` bằng URL Render và `ORBIT_BACKEND_SECRET` bằng khóa ở bước 2. Đặt phạm vi **Functions** nếu giao diện cho phép chọn. Giữ khóa trong biến môi trường và bật **Private** cho cả production lẫn preview tại **Visitor access → Project visibility**.
5. Deploy lại Netlify sau khi lưu biến. Đăng nhập với tư cách Team Owner, mở game, chọn **YouTube** rồi thử dán một link công khai. Khi chuẩn bị xong, bấm **Bắt đầu chơi**.

Render Free ngủ sau 15 phút không có lưu lượng. Lần đầu dán link sau khi ngủ có thể chờ khoảng một phút để server thức dậy. Cache bài mất khi Render ngủ, khởi động lại hoặc deploy. YouTube có thể chặn tải từ IP máy chủ hoặc yêu cầu xác minh. Kiểm tra bằng link thật sau khi deploy để biết backend Render có tải được. Nếu thiếu biến môi trường, Netlify chạy ở chế độ demo. Tài liệu [Render Free](https://render.com/docs/free), [Netlify Server](https://docs.netlify.com/build/server/) và [Netlify Project Visibility](https://docs.netlify.com/manage/security/secure-access-to-sites/project-visibility/).

## Tự phân tích YouTube

1. Chọn **YouTube** và dán link. Sau khoảng một giây game tự bắt đầu chuẩn bị; cũng có thể bấm **Phân tích**.
2. Chờ các bước **tải âm thanh → chuẩn hóa → dò điểm khởi âm → nạp âm thanh vào bộ nhớ**.
3. Chỉ khi cả âm thanh và bản đồ nốt đã xong, nút **Bắt đầu chơi** mới được mở.
4. Bấm bắt đầu. Có hai giây đếm vào trước khi âm thanh phát.
5. Dùng D/F/J/K, tay cầm, chuột hoặc cảm ứng để đánh đúng cột tại vạch sáng. Esc tạm dừng. **Dừng lượt** để đổi bài.

Vị trí nốt dùng trực tiếp từng thời điểm khởi âm trong bản thu. Game dùng mật độ nốt mặc định và gán cột theo độ sáng phổ. Cả chart tự động (YouTube, tệp nhạc) và demo đều hỗ trợ nốt đơn và nốt giữ.

Khi chơi, âm thanh đã tải dùng chung đồng hồ Web Audio với nốt. Nếu có hình từ video YouTube, game phát một bản MP4 không tiếng phía sau đường băng và căn thời gian hình theo âm thanh. Video tải chậm vẫn có thể tiếp tục chơi với âm thanh đã nạp. Có liên kết mở video gốc bên cạnh tên bài.

Lần đầu có thể mất vài phút do tải và khởi tạo thư viện; những lần sau dùng cache. Có thể **Hủy chuẩn bị** hoặc thử lại khi lỗi. Video công khai tối đa **10 phút**, nguồn tải tối đa **100 MB**; không hỗ trợ livestream. Video bị YouTube hạn chế hoặc yêu cầu xác minh có thể không tải được. Tool không tự đọc cookie hoặc đăng nhập tài khoản.

## Giới hạn nhận diện

Dò onset tự động là ước lượng. Hòa âm dày, tiếng hát, âm ngân dài hoặc bản thu nhiều tạp âm có thể tạo nốt dư hoặc thiếu. Mốc nốt bám theo từng điểm khởi âm đã phân tích. Độ trễ đầu ra còn phụ thuộc vào trình duyệt và thiết bị âm thanh.

## Công cụ trên máy

Đã cài thư viện vào `.tools/python/` riêng của dự án: yt-dlp, librosa, imageio-ffmpeg và phụ thuộc. Không thay thế Node/Python hệ thống.
Server dùng Python trong runtime Codex nếu có; có thể đặt biến môi trường `ORBIT_PYTHON` trỏ tới Python 3.12 của bạn.

Nếu chuyển máy hoặc thiếu thư viện, chạy:

```powershell
powershell -File .\Setup-Analysis.ps1
```

Máy cần Python có pip và Node.js. Công cụ dùng Node hiện đang chạy server để xử lý yêu cầu của bộ tải YouTube. Khi YouTube thay đổi cơ chế tải, có thể cần cập nhật yt-dlp và yt-dlp-ejs qua pip.

## Dữ liệu và cấu trúc

- `analysis/prepare.py`: tải âm thanh, nén MP3 44.1 kHz để phát và dò onset bằng librosa ở 22.05 kHz / hop 256; ước lượng BPM và độ sáng phổ.
- `analysis/jobs.mjs`: tiến trình nền, tiến độ, cache LRU tối đa 15 bài, hủy và timeout 12 phút.
- `server.mjs`: API localhost và phục vụ audio/video; kiểm tra Host/Origin, ID và giới hạn body.
- `public/engine.js`: chọn các onset nổi bật theo độ khó (Thường / Khó), chống lặp một cột liên tiếp và giữ nguyên timestamp.
- `public/app.js`: chuẩn bị bài, Web Audio, bù độ trễ đầu ra và Bluetooth, pause/resume an toàn với nốt giữ, Canvas và chấm điểm.
- `public/stage3d.js`: chiếu đường băng và khối nốt 3D lên Canvas, quy đổi tọa độ chạm sang cột.
- `.cache/analysis/<video-id>/`: lưu MP3 (hoặc WAV ở cache cũ), MP4 không tiếng (nếu có) và bản phân tích. Các tệp cache được Git bỏ qua.

## Kiểm tra

```powershell
node --test tests/engine.test.mjs
# Thay đường dẫn Python nếu máy không dùng runtime Codex:
& "$env:USERPROFILE\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe" tests/test_analysis.py
```

Có kiểm tra timestamp chart với tempo thay đổi, lọc nốt sát nhau, điểm/combo, phân tích âm thanh tổng hợp và từ chối im lặng. Độ chính xác của test tổng hợp không đại diện cho tất cả bản thu thật.

Tài liệu công cụ: [yt-dlp](https://github.com/yt-dlp/yt-dlp), [librosa onset](https://librosa.org/doc/latest/onset.html).
