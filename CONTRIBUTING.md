# 贡献指南

感谢你对 OpenClaw Switch 项目的关注！欢迎任何形式的贡献。

## 提交 Issue

- **Bug 报告** — 请使用 Bug Report 模板，包含复现步骤、预期行为和实际行为
- **功能建议** — 请使用 Feature Request 模板，描述你的需求和使用场景

## 提交 Pull Request

1. Fork 本仓库
2. 创建你的功能分支：`git checkout -b feature/my-feature`
3. 提交你的修改：`git commit -m "Add my feature"`
4. 推送到你的分支：`git push origin feature/my-feature`
5. 创建 Pull Request

### PR 规范

- 每个 PR 只做一件事
- 提交信息清晰描述修改内容
- 如果修复了某个 Issue，请在描述中关联：`Fixes #123`

## 开发环境

```bash
# 安装依赖
npm install

# 启动开发模式
npm start
```

## 代码风格

- 使用 2 空格缩进
- 使用单引号
- IPC 通道命名使用 kebab-case（如 `check-gateway`）
- 中文注释
