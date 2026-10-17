# R2 素材同步核对与上传计划

本文说明如何在没有网络、没有 R2 凭据的情况下，证明线上素材桶与本地发布渠道一致，并得到唯一正确的上传顺序。索引与素材包的格式、客户端路由规则见 `docs/RELEASE-POLICY.md` 的「运行时素材包（R2）」一节和 `docs/ASSETS.md`。

## 目标与边界

- 发布渠道（channel）是一个目录，内含若干 `assets-base-<version>.zip`、`assets-delta-<from>-<to>.zip` 和一份 `assets-index.json`；索引是渠道的权威清单，其他文件都是索引服务的内容寻址包。
- 线上状态只由一个**本地快照文件**描述（JSON 或 NDJSON）。`tools/r2-sync-plan.mjs` 只读取本地渠道与本地快照，不联网、不列桶、不上传、不删除，也不读取任何凭据；它输出的命令由维护者用本人凭据手工执行。
- 判断依据是内容而不是文件名：`sha256` 与字节数必须同时匹配才算「桶内已有」。因此相同的素材字节永远对应同一个内容寻址对象，不会因为换了版本号而重复上传。

## 快照格式

快照可以是一次只读列举的结果，手工保存为文件即可，例如：

```powershell
aws s3api list-objects-v2 --bucket <bucket> --query "Contents[]" > snapshot.json
```

接受的形态：

- 单个 JSON 文档：`{"objects":[...]}`、`{"Contents":[...]}`、`{"contents":[...]}` 或直接是一个数组（`aws s3api list-objects-v2 --output json` 的美化输出即属此类）。
- NDJSON：每行一个对象。
- 每个对象可以是 S3 字段（`Key`、`Size`、`ETag`、`Metadata`）或简写字段（`key`、`size`、`sha256`、`etag`）。

判定规则：

- 对象同时给出 `sha256` 时按 `sha256` 与 `size` 比对；只给出 `ETag`（32 位十六进制的单段上传 md5）时只能证明对象存在并按 `size` 比对。
- 既没有 `sha256` 也没有可用 `ETag` 的对象记为**不可验证**：快照无法为自身作证，计划直接判定为不可证明，而不是默认它健康。
- 重复列出的键、带目录前缀的键（只支持桶根对象）和空键都会被拒绝。
- 空列表默认被拒绝，提示 `the snapshot lists no objects at all`；只有确认桶确实是空的（首次发布）才加 `--allow-empty-bucket`。

## 计划格式

```powershell
node tools/r2-sync-plan.mjs --dir <渠道目录> --snapshot <快照文件> [--bucket <名>] [--endpoint <url>]
node tools/r2-sync-plan.mjs --dir <渠道目录> --snapshot <快照文件> --json
node tools/r2-sync-plan.mjs --dir <渠道目录> --snapshot <快照文件> --commands
node tools/r2-sync-plan.mjs --dir <渠道目录> --snapshot <快照文件> --quiet
```

`npm run assets:r2:sync-plan -- --dir <渠道目录> --snapshot <快照文件>` 与直接调用等价。

`--json` 输出单行 JSON（字段顺序固定，结尾换行）：

| 字段 | 含义 |
|---|---|
| `format` | `sp-assets-r2-sync-plan-v1` |
| `bucket` / `endpoint` | 计划中的桶名与可选端点；`--endpoint` 只影响打印的命令 |
| `channel` / `index` / `latest` / `indexKey` | 渠道目录、索引路径、索引中的最新版本、索引对象名 |
| `deterministic` | 恒为 `true`；相同输入必定字节一致，输出不含时间戳、随机数或主机信息 |
| `complete` | 只有渠道自身无问题、快照无不可验证对象时才为 `true` |
| `problems` | 全部问题文本（渠道、快照、不可验证对象） |
| `counts` | `objects`、`packages`、`missing`、`mismatched`、`unverifiable`、`upToDate`、`uploads`、`verifications`、`indexPublishes` |
| `uploads` | 需要上传的包（缺失或与索引不符），按 `key` 排序 |
| `verifications` | 每个上传对象对应的 `head-object` 校验项，按 `key` 排序 |
| `indexPublish` | 索引发布操作，或在无需发布时为 `null` |
| `operations` | 按 `order` 排序的完整操作序列，是唯一允许的执行顺序 |
| `upToDate` | 桶内已与索引一致的对象键，按 `key` 排序 |
| `packages` | 渠道内的包与其 `size` / `sha256`（内容寻址标识） |
| `contentIndex` | `sha256` → 携带这些字节的对象键；同一内容出现两次即视为重复上传并直接报错 |
| `strays` | 渠道目录中索引未服务的包文件（只报告，永不进入计划） |

每个操作记录 `order`、`action`、`bucket`、`key`、`kind`、`version`、`from`、`source`（本地文件）、`size`、`sha256` 与 `reason`；`head-object` 操作另有 `expect` 与 `verify: ["size","sha256","content-type","cache-control"]`。

固定顺序（不可调换）：

1. `upload`：只有缺失或与索引不符的内容寻址 ZIP，按 `key` 排序；
2. `head-object`：每个刚上传的对象立刻校验哈希与元数据；
3. `publish-index`：签名/索引元数据**最后**发布。`indexPublishedLast` 只有在确实发布索引且它是最后一个操作时才为 `true`。

## 退出码与「拒绝给出计划」

- 退出码 `0` 表示计划已经被证明：索引与本地包一致，快照中每个对象都带有可比对的 `sha256` 与字节数，渠道本身也没有问题。此时计划里仍可能出现 `upload`——缺失或与索引不符的对象是「发现」，不是「计划不成立」：按打印出的顺序执行即可（绝大多数情况下这一类只会有一个对象）。
- 计划无法被证明时退出码为 `1`，并且不会打印任何可能被误读为已完成的内容：
  - `--commands` 只输出一行 `# INCOMPLETE: the plan cannot be proven complete; no commands are emitted`；
  - 默认输出打印 `problem: ...` 后给出 `INCOMPLETE: ... nothing was uploaded and no commands are printed`；
  - `--json` 仍然输出计划，但 `complete` 为 `false`。
- 典型拒绝原因：快照为空（除非 `--allow-empty-bucket`）、缺少 `--dir` / `--snapshot`、索引与本地包不一致（例如 `index: base name ... does not match ...`、`... is listed in the index but missing in ...`）、两个键携带相同字节、索引格式不受支持。

## 操作手册

### 常规发布（先包后索引）

1. 在渠道目录产出本版本的素材包并刷新索引（`node tools/assets-r2.mjs release ...`），需要人工确认时先不加 `--write`。
2. 用本人凭据做一次只读列举，把结果保存为快照文件（见上）。
3. 运行 `node tools/r2-sync-plan.mjs --dir <渠道目录> --snapshot <快照文件> --commands`。
4. 退出码为 `1` 时**不要上传任何东西**：先按 `problem:` 行修正渠道或重新获取快照。
5. 退出码为 `0` 时按顺序执行：先跑第 1 段的 `aws s3 cp`（只上传计划列出的 ZIP，已一致的对象不会被重新上传），再跑第 2 段的 `aws s3api head-object` 逐项核对 `size` 与 `sha256`，最后跑第 3 段发布 `assets-index.json`。
6. 用 `--public-base <url>` 打印的地址确认 Worker 能从 R2 完整取回素材包与索引。

### 事后发现缺失对象

线上事后发现某个对象缺失或损坏（例如某次上传中断、对象被误删）时：

1. 重新做一次只读列举，保存新的快照文件，并再次运行同一命令。
2. 计划里只会出现该对象（`missing` 或 `mismatched`：`reason` 为 `missing in the bucket snapshot` 或 `the bucket snapshot does not match the index`），其余对象仍在 `upToDate` 中。
3. 只上传这一个缺失/不符的内容寻址 ZIP 到**现有的** r2 桶（对象名与本地渠道中的文件名一致，不新造对象名、不改名、不复制成第二份）。
4. 用 `head-object` 校验该对象的 `size` 与 `sha256` 与计划中的 `expect` 一致；不一致就停止并重新上传，绝不进入下一步。
5. 只有校验通过后，才发布/更新签名索引元数据（`assets-index.json` 永远最后上传）；其余对象在不必要时完全不动。
6. 如果本地渠道已经没有该对象，不要用改名或重打包的方式掩盖：从正式发布产物中取回原始 ZIP，或改为发布一个新的版本。

### 只更新程序本体的版本（无新素材）

新版本与已发布版本素材逐字节相同时（例如 2.6.4 相对 2.6.3 只更换程序本体）：

1. `node tools/assets-r2.mjs publish-version --dir <渠道目录> --version <新版本>` 先看报告：它只重写索引，记录 `versions[<新版本>] = {reused: <已发布版本>, reusedVia: base|delta}`，不写任何 ZIP、不新造对象名。
2. 确认后加 `--write` 写索引；随后可用 `--check` 断言索引确实记录了该复用关系。
3. 渠道内的对象集合没有变化，因此同步计划只包含一条最后发布的 `publish-index`，上传数为 `0`。
4. 客户端路由按复用版本解析：`node tools/assets-r2.mjs route --dir <渠道目录> --version <新版本> --inventory <sha256>` 仍会得到 `current`，不会把该版本判断为不可达。

离线冒烟检查（不写正式目录、不用真实基线，只使用系统临时目录）：

```powershell
node --test test/r2-sync-plan.test.js test/asset-package.test.js
```

前者构造一个无新素材的发布，断言复用指针存在、索引合法、`bases`/`deltas` 未变化，并断言同步计划的 `uploads` 为 `0` 且唯一操作是最后发布索引；后者断言没有版本因为复用指针变成不可达。任一条不成立即以非零码退出。

## 安全约束

- 仓库、脚本、索引、APK 和公开配置中不得出现 R2 密钥、账户信息、签名 URL 或令牌；代码中不读取凭据环境变量。
- `tools/r2-sync-plan.mjs` 不引入任何网络模块或 SDK，测试用替换 `fetch` 的探针断言调用次数为 `0`，并静态断言源码不含 `fetch(`、`node:http`、`node:https`、`undici`、`XMLHttpRequest`、`aws-sdk`。
- 工具不会上传、删除或列举远端对象；「列桶」只由维护者本人用凭据完成，且只做只读列举。
- 计划只允许桶根对象键；带前缀、绝对路径或以 `..` 逃逸的键一律拒绝。
- 相同输入必定得到字节一致的输出（排序固定、无时间戳/随机数/主机信息），便于在发布记录中留档复核。
