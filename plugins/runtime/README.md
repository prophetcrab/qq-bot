# runtime

事件驱动运行时的纯内核模块。

当前阶段只提供可测试的运行时对象，不接管线上消息链路：

```text
EventStore / ThreadTracker
ActivationScheduler / GroupActorRegistry
DynamicLexicon
Attention scoring
Episode / ReAct state machine
ToolRegistry
ExtensionRegistry (Game / Activity / LifeSource)
```

## 设计

- [ADR-0001](https://github.com/prophetcrab/dsh-qqbot/blob/dshbot-mac/docs/decisions/0001-event-runtime-plan.md)
- [ADR-0002](https://github.com/prophetcrab/dsh-qqbot/blob/dshbot-mac/docs/decisions/0002-runtime-v1-detailed-design.md)

## 原则

- 关键词只提高注意力，不强制回复
- 动态关键词持久化到 `data/state/runtime-lexicon.json`
- 事件可以 notBefore / deadline / snooze
- ActivationScheduler 驱动 ai-chat 批量延迟
- 每群独立预算
- 游戏规则不读取人格
- 工具通过 ReAct observation 回传

## 测试

```bash
node --import tsx --test test/runtime.test.ts
```
