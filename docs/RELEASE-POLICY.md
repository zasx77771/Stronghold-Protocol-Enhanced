# 发布版本规则

`release-policy.json` 是版本规则的唯一来源。每次功能改动完成后运行 `npm test`；它会先执行 `npm run check:release-policy`。CI 和 `npm version` 的前后生命周期钩子也会调用同一校验器。

## 版本映射

- 上游主线 `0.1.N` 映射到本地版本线 `0.N.*`。
- 合并新的上游主线时，本地版本必须从 `0.N.0` 开始。例如上游 `0.1.3` 对应本地 `0.3.0`。
- 同一上游主线内的小功能只递增最后一位：`0.3.1`、`0.3.2`。不能把新的上游主线发布为旧版本线的下一个小版本。

## 更新流程

1. 新上游主线合并后，先更新 `release-policy.json` 的 `upstreamMainlineVersion` 和递增后的 `androidVersionCode`，再将所有客户端版本元数据改为新的 `0.N.0`。
2. 只加入小功能时，递增 `package.json` 的最后一位，并同步锁文件、`shared/constants.js`、桌面运行时与 Android `versionName`。
3. 运行 `npm test`。规则会验证所有版本文件一致，并拒绝不符合上游映射的版本。
4. 客户端发布时，使用 `scripts/publish-client-release.ps1`；主线发布增加 `-MainlineUpdate`。发布脚本会再次校验规则，主线增量包成功后才清理两个主线端点之间的小版本完整包。
