# qq-bot 开发约定

这是 Koishi 运行时项目，DSH 插件的模板也以这里为准。

完整约定见：

<https://github.com/prophetcrab/dsh-qqbot/blob/dshbot-mac/CONTRIBUTING.md>

## 本仓库规则

- 开发主线：`main`
- 新功能/修复使用 `feat/*`、`fix/*` 分支
- 合并前必须通过：

```bash
npm test
npx tsc --noEmit
```

- `data/`、`logs/`、`runtime/`、`node_modules/` 不提交
- 不手工修改 `dsh-qqbot/template`；由本仓库同步生成
- 插件只通过 `ctx.qqbot.*` 服务通信，禁止跨插件 deep import
- AI 触发/上下文/批量/图片留在 Koishi；模型/人设/画像留在 DSH
- 跨端请求遵守 `dsh-qqbot/host/contracts` 的 schema
- AI 请求必须带 `apiVersion`
- 新玩法放 `plugins/games/<name>`，统一改 `group-listener`
- 不把上游模型错误原文直接发群

## 发布/模板同步

1. 在 `main` 完成插件改动并跑测试。
2. 同步到 dsh-qqbot：

```bash
rsync -a --delete \
  --exclude node_modules --exclude data --exclude logs \
  --exclude runtime --exclude runtime-bundles --exclude .git \
  ./ ~/project/dsh-qqbot/template/
```

3. 在 dsh-qqbot 跑 `npm run check` 后再提交。
