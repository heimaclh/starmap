# ✦ 我们的星图

一个加密的旅行照片墙 + 时间线网站。所有照片和文字在构建时用「暗号」AES-256-GCM 加密，
公开仓库里只有密文——**不知道暗号的人打开链接只能看到星空和输入框**。

## 目录结构

```
starmap/
├── photos/            # 原始照片（已被 .gitignore 排除，只留本地）
│   └── <旅行文件夹>/
├── trips.json         # 内容清单：旅行、地点、坐标、照片说明
├── build.py           # 构建脚本：压缩 + 读EXIF坐标 + 加密 → dist/
├── site/              # 网站源码（HTML/CSS/JS）
└── dist/              # 构建产物（发布这个目录）
```

## 日常使用（推荐：管理台）

一条命令启动：

```bash
python3 admin.py
```

- **管理台**：http://localhost:8124 （只在本机可访问，外网/局域网都连不上）
- **网站预览**：http://localhost:8123 （自动启动）

在管理台里：点「＋ 新旅行」→ 拖入照片（数量不限，自动读拍摄日期和 GPS）→ 写标题、
起止日期、地点和故事 → 给每张照片写一段描述 → 编辑详情正文 → 「保存修改」→ 「构建并发布」。
第一次构建前在「网站设置」里填好加密暗号，可勾选记住（存本机 `secret.txt`，已被 git 忽略）。

### 详情正文的排版规则（图文穿插）

- 空行 = 分段
- `## 标题` = 小节标题
- `> 一句话` = 引用块
- 单独一行写 `【图1】`、`【图2】`… = 把该旅行的第 N 张照片插入这个位置，
  照片下方显示你在管理台里写的描述——这就是图文穿插
- 没有被正文引用的照片会自动收进章节末尾的「✦ 更多瞬间」画廊，一张都不会丢

## 手机上传（安卓/iPhone）

照片在手机里时不用先导到电脑。电脑上运行：

```bash
./mobile.sh
```

按提示点一次 UAC 授权（自动配置 WSL 端口转发），终端会打印**手机访问地址**和 **6 位访问码**。
手机连同一 Wi-Fi，浏览器打开该地址 → 输入访问码 → 就是完整的管理台：拖选照片上传、
写说明、改正文、构建发布，全流程手机可做。

- 访问码每次启动随机生成，只在本机终端显示；错误 5 次会限速
- 管理台的 API 和照片在局域网内凭访问码 Cookie 保护（8 小时有效）
- 安卓手机在网站预览页选「添加到主屏幕」，星图会以全屏 App 形式打开（PWA）

## 手动方式（备用）

**1. 加照片**：把照片放进 `photos/某次旅行/`，然后在 `trips.json` 里照抄一段现有格式：

```json
{
  "id": "yunnan-2026",
  "title": "旅行标题",
  "date": "2026-05-01",
  "location": "云南 · 丽江",
  "description": "这次旅行的故事……",
  "photos": [
    { "file": "yunnan-2026/IMG_001.jpg", "caption": "照片说明" },
    { "file": "yunnan-2026/IMG_002.jpg", "caption": "照片说明", "coords": [26.87, 100.23] }
  ]
}
```

- 坐标 `coords` 可不填：手机拍的照片会自动从 EXIF 里读 GPS。
- 顶部 `site.anniversary` 填上纪念日（如 `"2023-10-01"`）会在首页显示"在一起的第 N 天"。

**2. 重新构建**：

```bash
python3 build.py --passphrase "你们的暗号"
```

**3. 本地预览**：

```bash
python3 -m http.server 8123 -d dist
# 浏览器打开 http://localhost:8123
```

## 发布到 GitHub Pages

```bash
cd starmap
git init && git add -A && git commit -m "✦ 初始化星图"
# 在 GitHub 建一个仓库后：
git remote add origin git@github.com:<用户名>/<仓库名>.git
git push -u origin main
# 把 dist 发布到 gh-pages 分支：
git subtree push --prefix dist origin gh-pages
```

然后到仓库 Settings → Pages → Source 选 `gh-pages` 分支，几分钟后网站就在
`https://<用户名>.github.io/<仓库名>/` 上线。

## 隐私说明（诚实版）

- ✅ 照片、文字、地点、纪念日全部 AES-256-GCM 加密，密钥由暗号经 PBKDF2（25 万次迭代）派生。
- ✅ 解锁只发生在访问者浏览器里，服务器/仓库里没有任何明文。
- ✅ 不被搜索引擎收录（noindex）。
- ⚠️ 安全性取决于暗号强度：请用至少 8 位、别人猜不到的暗号（纯生日/昵称容易被字典攻击）。
- ⚠️ 地图底图按访问者网络自动选择：高德（GCJ-02 坐标已做纠偏）→ GeoQ → OpenStreetMap；地图服务商能看到"有人看了某坐标附近的地图"，但看不到你们的照片和文字。
- ⚠️ 改暗号 = 重新跑一次 `build.py`，全部内容会用新暗号重新加密。

## 支持的格式

- 照片：JPG / PNG / WebP，iPhone 的 HEIC 需要先装 `pip3 install pillow-heif`
- 视频：MP4 / MOV / M4V / WebM。构建时自动用 ffmpeg 转码成 720p H.264（已内置 imageio-ffmpeg），
  并抽取一帧做封面海报；超过 150 MB 的视频会跳过并提示。视频和照片一样支持说明、地图定位、
  灯箱播放，时间线/照片墙/详情页混排展示。
