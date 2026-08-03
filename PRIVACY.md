# 隐私政策 — AI 中转站用量看板

**生效日期：** 2026-08-03

**适用产品：** AI 中转站用量看板 / AI Relay Usage Dashboard（Chrome 浏览器扩展）

---

## 我们收集哪些信息

**我们不收集任何用户信息。**

本扩展的所有数据（站点配置、余额、用量、历史趋势、本地设置）均只保存在用户本机浏览器的 `chrome.storage.local` 与 IndexedDB 中，不会上传到任何服务器。

---

## 我们绝不上传的内容

- API Key、Token、Session Cookie
- 用户名、密码或其他登录凭证
- 任何 API 响应原文或请求参数原文
- 任何可识别个人身份的信息（PII）
- 任何使用行为日志或遥测数据

---

## 权限用途说明

本扩展申请以下权限，仅用于在浏览器本地读取用户已登录的 AI 中转站公开余额与用量数据：

| 权限 | 用途 |
|------|------|
| `storage` / `unlimitedStorage` | 本地保存站点配置与采集数据。 |
| `alarms` | 定时唤醒后台脚本，执行自动采集。 |
| `cookies` | 读取目标站点的登录 Cookie 以完成 API 鉴权（仅内存使用，不落库）。 |
| `tabs` | 查找/创建已登录站点标签页，供页面脚本采集数据。 |
| `scripting` | 在用户已打开的同源站点注入采集脚本。 |
| `sidePanel` | 提供 Chrome 侧边栏面板。 |
| `activeTab` | 用户主动触发时临时访问当前标签页。 |
| `webRequest` | 监听已登录 SPA 站点的真实 API 请求元数据（仅 URL/状态码，不含响应体）。 |
| `notifications` | 会话过期或开始后台采集时发送系统通知。 |
| `declarativeNetRequest` | 为已启用站点动态添加 CORS 响应头（实验室功能，默认关闭）。 |

---

## 数据存储与安全

- 所有数据仅存于**用户本机**，扩展作者无法访问。
- 导出/导入的 JSON 文件由用户自行保管，其中**不包含 Cookie / Token / API Key**。
- 代码已开源，任何人都可以审计数据处理方式。

---

## 第三方服务

本扩展不调用任何第三方分析、广告或数据收集服务。所有网络请求均直接发往用户自行添加的 AI 中转站 API 端点。

---

## 代码开源

本项目采用开源方式发布，仓库地址：

**https://github.com/shanyuyulai/AI_Relay_Usage_Dashboard**

---

## 联系我们

如有关于隐私的疑问或建议，请通过 GitHub Issues 反馈：

**https://github.com/shanyuyulai/AI_Relay_Usage_Dashboard/issues**

---

## 政策更新

如果本隐私政策发生重大变更，我们将在 GitHub 仓库发布更新说明。
