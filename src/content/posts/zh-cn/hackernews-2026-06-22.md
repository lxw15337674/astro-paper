---
author: bhwa233
pubDatetime: 2026-06-21T16:00:00Z
modDatetime: 2026-06-22T12:19:30Z
title: "HackerNews Top 10｜2026-06-22"
featured: false
draft: false
tags:
  - HackerNews
ogImage: "https://docs.deno.com/runtime/desktop/index.png"
description: "Hacker News Top 10：Deno Desktop、Codex 日志写盘、开放模型、内联汇编安全与数学长文等热门讨论"
timezone: Asia/Shanghai
---

## 1. Deno Desktop

- **热度**：411 points · 165 评论
- **原文**：https://docs.deno.com/runtime/desktop/
- **HN 讨论**：https://news.ycombinator.com/item?id=48626137

Deno Desktop 是 Deno 官方即将在 2.9 版本推出的桌面应用打包能力：它可以把一个 Deno 项目，从单个 TypeScript 文件到 Next.js 应用，打成自包含的桌面应用二进制包。原文强调的卖点是“小体积默认值 + 完整 Node 兼容”：默认使用系统 WebView 来降低体积，同时仍可通过 Deno 的 Node 兼容层使用 npm 生态；需要更一致渲染环境时，也可以选择绑定 Chromium/CEF 后端。

评论区的关注点主要落在“共享 CEF runtime”这件事上。有人认为如果每个应用仍然各自绑定浏览器，那只是稍微减轻的 Electron 模式；也有人追问不同应用需要不同 CEF 版本时，共享 runtime 到底能否成立。另一个争议点是官方文档把 Web 技术称为最广为人知的 UI toolkit，有读者觉得这容易遮蔽 Electron 类应用真正的代价：包体、运行时、平台一致性与原生体验之间总得有人付账。

## 2. Help I accidentally a wigglegram

- **热度**：262 points · 51 评论
- **原文**：https://lmao.center/blog/wiggle-accidents/
- **HN 讨论**：https://news.ycombinator.com/item?id=48605561

这篇文章讲的是作者意外发现自己的相册里藏着大量“可生成 wigglegram 的照片序列”。wigglegram 是一种把相近视角照片循环播放、制造伪 3D 立体感的图像形式。作者因为拍照时常常从略有差异的角度连拍，又长期不清理相册，于是想到用感知哈希去扫描 iCloud 照片库，自动找出相似照片片段并拼成 wigglegram。

评论区整体很轻松：有人分享用四个树莓派相机做定制立体相机的项目，也有人推荐自己写的 matplotlib 伪 3D 可视化库。更有意思的是，不少读者喜欢这篇文章和脚本的“手写感”，觉得在 AI 代码越来越多的背景下，这种带个人痕迹的小工具反而显得清爽。它不是重大技术突破，但胜在问题具体、方法直接、结果好玩。

## 3. Did my old job only exist because of fraud?

- **热度**：577 points · 249 评论
- **原文**：https://david.newgas.net/did-my-old-job-only-exist-because-of-fraud/
- **HN 讨论**：https://news.ycombinator.com/item?id=48622867

作者回顾自己早年在 GenieDB 的经历：这家英国创业公司被美国 VC 机构 Frost VP 接管后，他几乎成了唯一被带到美国继续工作的成员。多年后他看到 Frost 涉嫌欺诈的 SEC 诉讼材料，开始追问一个很刺人的问题：那份改变了自己人生轨迹的工作，是否本质上只是基金通过孵化公司收取费用的结构性副产品？文章从个人记忆切入，延伸到 VC 孵化器、费用安排和创业叙事背后的激励错位。

评论区把这个故事扩展到了更普遍的组织问题。有人提到大公司裁掉承包商后，又通过大型外包供应商把同一批人以更高成本买回来；也有人指出全职员工、独立承包商和外包公司常常分属不同预算科目，管理层可以在一个科目上“降本”，再在另一个科目上超支。讨论的重点不是单案八卦，而是组织激励如何让荒唐安排看起来合规，甚至让每个参与者都觉得自己只是在完成工作。

## 4. Codex logging bug may write TBs to local SSDs

- **热度**：99 points · 57 评论
- **原文**：https://github.com/openai/codex/issues/28224
- **HN 讨论**：https://news.ycombinator.com/item?id=48626930

这个 GitHub issue 指出 Codex 本地 SQLite feedback log 可能持续大量写入 `~/.codex/logs_2.sqlite` 及其 WAL/SHM 文件。报告者给出的证据相当具体：约 21 天机器运行时间里主 SSD 写入约 37TB，外推接近 640TB/年；样本数据库里 TRACE 日志占保留字节的约 70.7%，再加上 mirrored telemetry 相关日志，可能覆盖了绝大多数写入来源。问题的严重性在于它不是“日志文件大一点”这么简单，而是可能直接消耗消费级 SSD 的写入寿命。

HN 评论区情绪很重，很多人把这个问题和 Codex 客户端其他资源消耗问题放在一起批评，也有人贴出临时 SQLite trigger 来阻止插入日志，或用 VACUUM 显著缩小数据库。技术上最值得关注的是修复方向：过滤高频 TRACE、限制 websocket/SSE payload 级日志、控制 WAL 写入和保留策略，这些比让用户手工清数据库靠谱得多。这个条目也很适合给本地代理工具开发者当反面教材：可观测性不能以偷偷磨 SSD 为代价。

## 5. Apertus – Open Foundation Model for Sovereign AI

- **热度**：394 points · 131 评论
- **原文**：https://apertvs.ai/
- **HN 讨论**：https://news.ycombinator.com/item?id=48622778

Apertus 是 Swiss AI Initiative 推出的开放基础模型项目，由 EPFL、ETH Zurich 和 CSCS 合作推进。原文主打“open weights、open data、open science”，强调训练数据、代码、权重、方法和对齐原则都可文档化、可复现；同时它也把 EU AI Act 合规、opt-out、PII 移除和防记忆化作为定位的一部分。项目叙事很明确：这是面向技术主权和公共科研基础设施的开放模型。

评论区并没有只顺着宣传走。有人拿 OLMo、K2 Think、Nvidia Nemotron 等开放训练或部分开放数据模型作横向比较，讨论“完全开放”到底包括哪些层次；也有人赞赏 Allen AI 这类组织长期做开放路线。另一边，怀疑者担心 Apertus 可能“以委员会速度移动”，在竞争力上落后于美国和商业前沿模型。这个话题的真正分歧是：开放、合规和主权是否能与模型能力迭代速度同时成立。

## 6. Munich 1991: The Roots of the Current AI Boom

- **热度**：73 points · 21 评论
- **原文**：https://people.idsia.ch/~juergen/ai-boom-roots-munich-1991.html
- **HN 讨论**：https://news.ycombinator.com/item?id=48599998

这篇文章由 David Ha 作序，围绕 Jürgen Schmidhuber 团队在 1991 年慕尼黑的工作，试图把现代 AI 热潮的多个关键构件追溯到那个时期：早期 Transformer 变体、无监督预训练、神经网络蒸馏、深度残差学习以及生成式对抗网络的前身思想。文章的立场非常鲜明：今天大模型产业的许多根基，早在三十多年前的学术研究中已经埋下。

评论区自然转向“学术研究到底有没有用”和“谁应该被引用”的老战场。有人指出许多当年看似无用、无法大规模落地的神经网络研究，后来成了私营实验室和大模型公司踩着前进的地基；也有人认为 Schmidhuber 长期强调优先权和引用问题，容易把相似思路、重新发明和工程规模化之间的关系说得过于线性。这篇适合当 AI 史阅读，但读的时候最好把“技术谱系”和“功劳归属”拆开看。

## 7. GLM 5.2 vs. Opus

- **热度**：144 points · 110 评论
- **原文**：https://techstackups.com/comparisons/glm-5.2-vs-opus/
- **HN 讨论**：https://news.ycombinator.com/item?id=48626866

原文把 GLM-5.2 和 Claude Opus 4.8 放到同一个 one-shot 编程任务里比较：要求模型用原生 WebGL 从零做一个 3D 平台游戏。作者的结论并不极端：Opus 更快、结果更干净，也能检查视觉输出；GLM-5.2 便宜很多，开放权重、可长期保有，并且在长上下文和 coding agent 场景里有价值。文章给出了构建时间、输出 token、上下文占用、工具调用和估算成本等指标，强调这不是“GLM 全面打赢”，而是开放模型已经足够进入工具箱。

评论区对 one-shot benchmark 很不客气。很多读者认为“让模型一次性写出 X”不是现实软件工程，更不能代表 coding agent 的可靠性；更有价值的测试应该是模型能否按人类定义的 spec、guardrails 和计划文件稳定执行，能否在循环中发现 bug、持续修复且不漂移。这个争议很健康：模型评测如果只看炫技 demo，很容易奖励会猜题的系统，而不是能被托付工作的系统。

## 8. Investors get real-time view of UK bond market activity for the first time

- **热度**：22 points · 1 评论
- **原文**：https://www.fca.org.uk/news/press-releases/investors-get-real-time-view-uk-bond-market-activity-first-time
- **HN 讨论**：https://news.ycombinator.com/item?id=48626918

英国 FCA 宣布上线债券 consolidated tape，由 ETS Connect UK 运营，目标是把分散在多处的英国债券成交价格和交易活动汇总成单一实时数据源。原文给出的背景是，2025 年 12 月英国债券市场透明度规则改变后，实时报告比例已经显著上升：公司债从不到 5% 提高到超过 75%，政府债从约 30% 提高到约 80%。consolidated tape 则是把这些透明度改造成可用基础设施的最后一步。

这个条目评论很少，唯一明显补充是有人指出 ETS Connect 页面信息略多，但服务似乎还不是真的对外可用。它在 HN 上热度不高也正常：这不是开发者日常工具，但对市场微观结构、固定收益交易和监管透明度来说很重要。真正值得后续观察的是数据覆盖率、延迟、许可价格和实际可访问性，而不是新闻稿里的“first country outside North America”这类漂亮句子。

## 9. Memory Safe Inline Assembly

- **热度**：116 points · 25 评论
- **原文**：https://fil-c.org/inlineasm
- **HN 讨论**：https://news.ycombinator.com/item?id=48606096

Fil-C 的这篇文档讨论一个听上去很拧巴的问题：如何支持 GCC/Clang 风格的 inline assembly，同时仍维持内存安全。原文解释说，内联汇编常被用于阻止编译器分析、表达特定指令或处理性能关键路径；Fil-C 的做法不是假装 asm 天然安全，而是分析 asm 约束、寄存器、clobber 和内存行为，如果判断不安全，运行时会 panic 或触发非法指令陷阱。文档也明确提醒这是预发布特性，Fil-C 0.679 尚未包含。

评论区争议集中在“编译期能发现的不安全，为什么不是编译期错误”。有人认为把已知安全问题延后到 runtime panic 很荒唐，因为测试未覆盖就会让客户踩雷；也有人替这个设计辩护：对于把现有 C 项目迁到 Fil-C 的场景，warning + runtime panic 可能比一上来硬错误更利于迁移，类似 GHC 的 deferred type errors。更底层的分歧是，安全语言或安全 C 方言到底应该优先保证部署不可达，还是优先让复杂旧代码先跑起来再逐步收紧。

## 10. Everything is logarithms

- **热度**：236 points · 47 评论
- **原文**：https://alexkritchevsky.com/2026/05/25/everything-is-logarithms.html
- **HN 讨论**：https://news.ycombinator.com/item?id=48622626

这篇数学长文试图换一种方式理解对数：把“无底对数”当成一种抽象对象，再把常见的以 2、e、10 为底的对数理解为用不同单位度量同一个几何量。作者把换底公式解释成单位换算，就像公里到米、字节到 bit 一样；`log 2` 可以看作 bits，`log e` 可以看作 nats，`log 10` 可以看作 digits。文章的价值不在于推导多新，而在于把熟悉公式从“符号规则”重新翻译成“单位和尺度”的直觉。

评论区马上有人把它联系到 torsor：位置、货币、日历日期等对象本身依赖某种任意选择，torsor 可以帮助我们在不预先指定原点或单位的情况下谈论它们。也有人指出，作者其实写过 geometric algebra 相关内容，里面也触及过对象和操作混淆的问题。这个条目适合喜欢数学直觉文章的人看；它不会改变对数定义，但能让换底公式少一点机械背诵味。
