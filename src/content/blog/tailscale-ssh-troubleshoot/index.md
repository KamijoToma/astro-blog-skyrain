---
title: Tailscale SSH 间歇性失效排障复盘
description: '从 debug netmap 的 SSHPolicy 为空入手，区分现场证据与规则语义推断，定位身份模型冲突导致的 Tailscale SSH 间歇性失效。'
publishDate: 2026-03-21
tags:
  - Tailscale
  - SSH
  - 网络
  - 故障排查
  - ACL
language: 'zh-CN'
comment: true
ai: polish
---

## 摘要

这次故障的现象并不复杂：

- `tailscale ssh root@...` 在一段时间内可以正常连接
- 随后开始稳定报错：`tailnet policy does not permit you to SSH to this node`
- 目标机执行 `tailscale debug netmap | jq '.SSHPolicy'` 时，结果是：

```json
{
  "rules": []
}
```

最后的处理方式也不复杂：

- 不再给 `KawaiiDesktop` 打 `tag:mobile-network`
- peer-relay 能力改为精确授予给该设备，而不是靠这个 tag 来命中
- `tag:ability-relay` 和 `tag:role-ssh-server` 继续保留在服务端设备上

修复后：

- Tailscale SSH 恢复正常
- peer-relay 仍可用

但这次排障真正值得记录的，不是"改了哪条 JSON"，而是两个方法论：

1. 要把"现场上能证明的事实"和"基于文档的推断"分开写
2. 要区分"控制台中的原始 policy"与"节点本地 `debug netmap` 里的有效结果"

---

## 1. 现场现象

故障时，源机上的直接报错是：

```text
tailscale: tailnet policy does not permit you to SSH to this node
```

普通 `ssh` 也会表现为 22 端口连接失败，例如：

```text
ssh: connect to host 100.111.93.8 port 22: Permission denied
```

这类报错很容易把排障方向带到以下几条：

- 目标机没有启用 Tailscale SSH
- 控制面 policy 没同步到目标机
- `tailscaled` 和控制面的连接不稳定
- SSH 规则语法写错

这几条里，前两条在一开始都非常像真相。但最终证据表明，这次真正的问题并不在这里。

---

## 2. 先给出原始配置

网页控制台中的核心 ACL 如下：

```json
{
  "acls": [
    {
      "action": "accept",
      "src": ["*"],
      "dst": ["*:*"]
    }
  ],
  "ssh": [
    {
      "src": ["autogroup:member"],
      "dst": ["tag:role-ssh-server"],
      "users": ["autogroup:nonroot", "root"],
      "action": "accept"
    }
  ],
  "tagOwners": {
    "tag:mobile-network": ["autogroup:network-admin"],
    "tag:ability-relay": ["autogroup:network-admin"],
    "tag:role-client": ["autogroup:network-admin"],
    "tag:role-ssh-server": ["autogroup:network-admin"]
  },
  "grants": [
    {
      "src": ["tag:mobile-network"],
      "dst": ["tag:ability-relay"],
      "app": {
        "tailscale.com/cap/relay": [""]
      }
    }
  ]
}
```

当时的意图是：

- 网络层先全部放通
- 带 `tag:role-ssh-server` 的机器允许 Tailscale SSH
- 带 `tag:mobile-network` 的设备被允许使用 peer-relay

从"业务意图"看，这组配置是自洽的。问题出在更隐蔽的层面：同一台机器同时被用于"人用终端设备"与"被 tag 建模的设备能力来源"。

---

## 3. 这次有哪些事实是可以直接证明的

这一节只写能从现场输出直接得出的事实，不做解释。

### 3.1 目标机的 `tailscaled` 正在稳定收控制面更新

目标机执行：

```bash
sudo tailscale debug metrics | egrep 'controlclient_map_(requests|response_map|response_map_delta|response_keepalive)'
```

输出中有：

```text
controlclient_map_requests 780
controlclient_map_requests_active 1
controlclient_map_response_map 1004
controlclient_map_response_map_delta 987
controlclient_map_response_keepalive 5965
```

这些指标本身并不解释规则为什么为空，但足以说明一件事：

- 目标机一直在收控制面 map 更新

因此，这次问题不能简单归因为"目标机已经很久没从控制面拿到新 policy"。

### 3.2 强制刷新后，目标机拿到的有效 SSHPolicy 仍然为空

目标机执行：

```bash
sudo tailscale debug force-netmap-update
sleep 2
sudo tailscale debug netmap | jq '.SSHPolicy'
```

结果仍然是：

```json
{
  "rules": []
}
```

这说明：

- 不是"还没刷新到"
- 而是"刷新后结果依然为空"

### 3.3 目标机的 `tailscaled` 没有重启或崩溃

目标机执行：

```bash
sudo systemctl status tailscaled --no-pager
```

可以看到该进程已经持续运行 4 天，没有 panic、fatal、restart 的证据。

因此，这次问题也不能归因于"daemon 崩了，导致本地状态失真"。

### 3.4 故障前后，目标机对同一个来源的评估结果发生过切换

目标机日志里最关键的几行是：

```text
Mar 21 17:31:17 ... access granted to KamijoToma@github as ssh-user "root"
Mar 21 17:37:36 ... session no longer valid per new SSH policy; closing
Mar 21 17:37:58 ... tailnet policy does not permit you to SSH to this node: failed to evaluate policy, result: rejected
```

这几行能直接证明三件事：

1. `2026-03-21 17:31:17 CST` 时，源机到目标机的 SSH 曾经是允许的
2. `2026-03-21 17:37:36 CST` 时，目标机收到了"新的 SSH policy"，并用它重新评估了现有会话
3. 新评估结果是不允许，于是旧会话被踢掉，后续新连接也开始稳定失败

这一段日志是本次排障里最重要的证据。它说明问题不是"随机网络波动"，而是"策略评估结果在某个时间点发生了切换"。

### 3.5 源机与目标机当时的本地身份视图如下

源机 `KawaiiDesktop`：

```json
{
  "Name": "kawaiidesktop.tail02ef4.ts.net.",
  "User": 4989053761742821,
  "Tags": [
    "tag:mobile-network"
  ],
  "MachineAuthorized": true,
  "KeyExpiry": "2026-09-17T09:41:38Z"
}
```

目标机 `kimiclaw`：

```json
{
  "Name": "kimiclaw.tail02ef4.ts.net.",
  "User": 7685370292204740,
  "Tags": [
    "tag:role-ssh-server"
  ],
  "MachineAuthorized": true,
  "KeyExpiry": null
}
```

这说明：

- 源机是一个被打了 `tag:mobile-network` 的设备
- 目标机是一个被打了 `tag:role-ssh-server` 的设备

至于这两件事在策略评估中意味着什么，要放到下一节，结合官方文档讨论。

---

## 4. 规则语义上，哪些结论可以直接引用官方文档

这一节只写我能在 Tailscale 官方文档中找到直接依据的部分。

### 4.1 `ssh` 规则里的 `dst` 不写端口

官方 policy 语法文档说明：

- `acls` 的 `dst` 使用的是 `IP:port` 风格
- `ssh` 段是单独的规则类型，目标选择器与网络 ACL 不同

参考：

- [Policy file syntax](https://tailscale.com/docs/reference/syntax/policy-file)

这也是为什么这次的 SSH 规则写成：

```json
"dst": ["tag:role-ssh-server"]
```

本身没有语法问题。

### 4.2 `autogroup:member` 是当前文档中的有效选择器

官方"Targets and selectors"文档里把 `autogroup:member` 列为选择器之一，用于匹配 tailnet 成员。

参考：

- [Targets and selectors](https://tailscale.com/docs/reference/targets-and-selectors)

因此，这次问题不能简单归因为"把 `autogroup:member` 写错了"。

### 4.3 tag 的设计目标是给设备赋予身份或角色

官方 tag 文档对 tag 的描述是：

> "Tags allow you to assign an identity to a device"

参考：

- [Tags](https://tailscale.com/docs/features/tags)

同一页还强调了一个更重要的点：

> "If a device has a tag, the tag becomes that device's identity"

以及：

> "A single device cannot simultaneously have both a user-based identity and a tag-based identity"

参考：

- [Tags](https://tailscale.com/docs/features/tags)

这三句原文很关键。它们并没有直接写"给桌面设备打 tag 一定会导致 SSH 失败"，但它们清楚地说明了：

- tag 不只是一个便签
- tag 会参与设备身份建模
- user-based identity 和 tag-based identity 不应被混用为同一种东西

### 4.4 peer-relay 的 grant 适合使用精确选择器

官方 peer-relay 文档建议，对 relay capability 的授权要尽量精确，文中给出的示例选择器包括：

- tags
- hostnames
- IP sets

参考：

- [Peer Relay](https://tailscale.com/docs/features/peer-relay)

这意味着：为了给单台用户桌面设备授予 peer-relay 能力，并不一定要给它打一个 tag；也可以用更精确的源选择器来做授权。

---

## 5. 哪些判断是"基于文档和现场证据的推断"

这一节不把推断写成"官方已证明"，而是明确标注为推断。

### 5.1 推断一：这次问题更像是身份模型冲突，而不是同步故障

这个判断基于两组事实：

- 现场上，目标机一直在稳定接收控制面更新，且 `force-netmap-update` 后结果不变
- 文档上，tag 会参与设备身份建模，且 tag-based identity 与 user-based identity 不应混用

因此，更合理的解释不是：

- "目标机没拿到最新 policy"

而是：

- "目标机拿到了最新 policy，但对源机身份的评估结果变了，导致这条 SSH 规则不再命中"

这是推断，不是我从 Tailscale 源码里直接验证出的唯一结论；但它与现场日志和官方文档是相互一致的。

### 5.2 推断二：`KawaiiDesktop` 被打上 `tag:mobile-network` 后，可能不再稳定地命中 `autogroup:member`

我能直接证明的事实是：

- `KawaiiDesktop` 带有 `tag:mobile-network`
- SSH 规则的 `src` 写的是 `autogroup:member`
- 故障在某一时刻从"允许"切换到"拒绝"
- 移除该 tag 后，问题恢复正常

我不能直接从这次现场输出证明的，是"控制面内部究竟在哪一个函数、哪一个时刻把它从 member 视角切到了 tag 视角"。这部分如果要继续求证，需要进一步查 Tailscale 源码或向官方确认。

但从现象、日志、修复结果和文档语义拼起来，最朴素也最一致的解释就是：

- 给这台人用桌面设备加上 `tag:mobile-network`
- 让它同时承担了"用户设备"和"tag 设备能力来源"两种角色
- 这与 `src: ["autogroup:member"]` 的建模方向冲突

因此，我在这篇复盘里把它写成"高置信度推断"，而不是"已经由源码完全证明的定论"。

---

## 6. 为什么 `debug netmap` 很关键

这次还有一个容易误判的点：我一开始也倾向于把 `debug netmap` 看成"控制台 ACL 的本地镜像"。后来结合现场输出，才意识到这更像是"本节点当前收到并生效的网络图结果"。

这个判断不是凭空来的，依据是输出内容本身：

- 它包含 `SelfNode`
- 它包含 `Peers`
- 它包含 `PacketFilter`
- 它包含 `SSHPolicy`

这些都更像运行时视图，而不是原始配置文件。

因此，当目标机执行：

```bash
sudo tailscale debug netmap | jq '.SSHPolicy'
```

得到：

```json
{
  "rules": []
}
```

更自然的解释是：

- 对这台目标机而言
- 当前控制面下发并计算后的有效 SSH 规则集为空

而不是：

- 控制台里没有写 SSH 规则

这一区分非常重要，因为它直接决定排障路径是去看：

- 控制台 JSON 有没有保存

还是去看：

- 当前节点身份和规则选择器是否仍然匹配

这次正确答案是后者。

---

## 7. 最终改法，以及为什么它更稳

最终采用的修复方式是：

1. 不再给 `KawaiiDesktop` 打 `tag:mobile-network`
2. 继续给 relay 节点保留 `tag:ability-relay`
3. 把 peer-relay grant 从"按 tag 匹配源设备"改成"按具体设备精确匹配"

例如，把：

```json
{
  "src": ["tag:mobile-network"],
  "dst": ["tag:ability-relay"],
  "app": {
    "tailscale.com/cap/relay": [""]
  }
}
```

改成类似：

```json
{
  "src": ["100.65.35.109"],
  "dst": ["tag:ability-relay"],
  "app": {
    "tailscale.com/cap/relay": []
  }
}
```

这里的 `100.65.35.109` 是 `KawaiiDesktop` 的 Tailscale IP。

这样改的好处是：

- peer-relay 能力仍然存在
- SSH 规则仍然可以继续按 `autogroup:member -> tag:role-ssh-server` 建模
- 不需要再让一台人用桌面设备承担 tag-based identity 的职责

这并不是官方唯一推荐方案，但它符合官方文档对 tag、selector 和 relay grant 精确授权的整体语义。

---

## 8. 这次我愿意留下来的排障步骤

如果以后再遇到类似问题，我会按下面的顺序查。

### 8.1 先确认是"目标机拒绝"，还是"网络本身不通"

```bash
tailscale ssh root@host exit
tailscale ping host
```

如果 `tailscale ping` 正常，而 `tailscale ssh` 报：

```text
tailnet policy does not permit you to SSH to this node
```

那就优先去查目标机上的 `SSHPolicy`。

### 8.2 在目标机看当前有效 SSHPolicy

```bash
sudo tailscale debug netmap | jq '.SSHPolicy'
```

如果结果是：

```json
{"rules":[]}
```

说明此时此刻，这台目标机收到的有效 SSH 规则为空。

### 8.3 再确认是不是同步问题

```bash
sudo tailscale debug metrics | egrep 'controlclient_map_(requests|response_map|response_map_delta|response_keepalive)'
sudo tailscale debug force-netmap-update
sleep 2
sudo tailscale debug netmap | jq '.SSHPolicy'
```

如果控制面 map 指标在增长，强制刷新后还是空，那排障重点就该转向"规则为何不匹配"，而不是"为什么没同步"。

### 8.4 一定要看目标机日志

```bash
sudo journalctl -u tailscaled --since "YYYY-MM-DD HH:MM" | egrep -i 'ssh|policy|control|map'
```

重点找下面几类语句：

- `access granted`
- `session no longer valid per new SSH policy; closing`
- `failed to evaluate policy, result: rejected`

只要看到第二句，基本就能确认：问题不是链路波动，而是策略评估结果发生了切换。

### 8.5 对照源机和目标机的 `SelfNode`

```bash
tailscale debug netmap | jq '.SelfNode | {Name, User, Tags, MachineAuthorized, KeyExpiry}'
```

排查时不要只盯着"在线/离线"，还要看：

- 有没有 tag
- tag 是不是拿来建模了设备角色
- 当前规则的 `src` 和 `dst` 选择器，到底和这台机器的身份模型是不是同一个方向

---

## 9. 这次复盘里，我最想保留的一句话

这次故障最后的启发，不是"某条规则写错了"，而是：

- Tailscale policy 的关键，不只在于"你写了什么"
- 还在于"控制面最终把这台设备当成什么身份来评估"

如果一台设备同时被你当成：

- user-authenticated 的人用设备
- tag-based 的角色设备

那就很容易出现一种最难排查的故障：

- 配置看起来都对
- 也不是完全不通
- 但在控制面重新评估后的某个时刻，规则突然不再命中

这次我采用的修复方法，本质上是在做一件很朴素的事情：

- 让人用设备继续保持"人用设备"的身份
- 把特殊能力单独、精确地授予给它
- 不为了拿到一个 capability，就顺手改变整台设备的身份模型

从结果看，这条思路是有效的。

---

## 参考文档

- [Policy file syntax](https://tailscale.com/docs/reference/syntax/policy-file)
- [Targets and selectors](https://tailscale.com/docs/reference/targets-and-selectors)
- [Tags](https://tailscale.com/docs/features/tags)
- [Tailscale SSH](https://tailscale.com/docs/features/tailscale-ssh)
- [Peer Relay](https://tailscale.com/docs/features/peer-relay)
