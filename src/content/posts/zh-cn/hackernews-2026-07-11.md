---
author: bhwa233
pubDatetime: 2026-07-10T16:00:00Z
modDatetime: 2026-07-11T07:51:19Z
title: "HackerNews Top 10｜2026-07-11"
featured: false
draft: false
tags:
  - 定时文章
  - HackerNews
ogImage: "../../../../public/images/hn-cover.svg"
description: "苹果起诉OpenAI窃密、星链申请十万卫星、“工具应无形”设"
timezone: Asia/Shanghai
---

## 1. 爱因斯坦相对论主导重元素化学键

- **热度**：205 points · 71 评论
- **原文**：https://www.brown.edu/news/2026-07-09/chemical-bonds-relativity
- **HN 讨论**：https://news.ycombinator.com/item?id=48866134

布朗大学化学家通过光电子能谱直接观测到，在重元素（如铋）的三键中，相对论效应导致自旋-轨道耦合，使传统教科书中的σ键和π键边界模糊，形成混合键。这是首次直接光谱学证据，可能改写化学教材，并对铋在太阳能电池、量子材料中的应用产生影响。

HN评论指出，相对论对重元素化学的影响早在1970年代就被理论预测，但本次研究首次通过实验直接观测到轨道结构，验证了狄拉克方程。评论还提到金的颜色、铅的电池特性等已知相对论效应，并讨论了玻姆力学等非相对论框架的局限性。

## 2. QuadRF能透过墙壁探测WiFi和无人机

- **热度**：542 points · 191 评论
- **原文**：https://www.jeffgeerling.com/blog/2026/quadrf-can-spot-drones-and-see-wifi-through-my-wall/
- **HN 讨论**：https://news.ycombinator.com/item?id=48861717

QuadRF是一款基于树莓派5和FPGA的开源相控阵无线电，利用MIPI接口实现超过5 Gbps的SDR IQ数据流，工作频率4.9-6 GHz。它可实时可视化WiFi信号、追踪无人机，并内置增强现实查看器。基础套件499美元，众筹已超预期，支持多模块级联。

HN评论中，QuadRF作者亲自解答技术细节（如1-bit ΣΔ ADC、FPGA时钟抖动），并分享未来改进方向。其他评论讨论该设备可能被武器化、用于探测隐藏摄像头，类比政府监听能力，并提及类似声学定位设备。

## 3. 苹果起诉OpenAI，指控前员工窃取商业机密

- **热度**：963 points · 475 评论
- **原文**：https://9to5mac.com/2026/07/10/apple-sues-openai-trade-secret-theft/
- **HN 讨论**：https://news.ycombinator.com/item?id=48865019

苹果在加州联邦法院起诉OpenAI，指控前iPhone设计副总裁Tang Tan和工程师Chang Liu等人在面试及离职过程中，利用苹果内部项目代号索要机密信息、携带实物部件、下载数千页工程文档，甚至利用安全漏洞持续窃取数据。OpenAI被指利用这些机密推进其硬件业务（已收购Jony Ive的io公司），苹果寻求禁令和赔偿。

HN评论普遍认为苹果证据充分，可能终结OpenAI硬件计划；部分评论类比Waymo诉Uber案。也有评论指出OpenAI商业模式依赖版权侵犯，企业使用其模型需谨慎。少数评论批评苹果自身也有抄袭历史。预计双方最终会达成和解。

## 4. 苏联控制室的复古之美（2018）

- **热度**：47 points · 15 评论
- **原文**：https://designyoutrust.com/2018/01/vintage-beauty-soviet-control-rooms/
- **HN 讨论**：https://news.ycombinator.com/item?id=48868996

文章展示了一组苏联时代控制室照片，布满巨大的按钮和模拟表盘，反映了计算机普及前的工业控制美学，包括切尔诺贝利4号反应堆控制室。

HN指出这种风格并非苏联独有，西方1970年代的核电站也有类似设计。评论讨论了SCADA用户界面从物理面板到数字屏幕的演化，以及信息密度和操作员认知负荷的变化。还推荐了“为什么控制室是海泡绿”等相关文章。

## 5. 基于iroh的智能风扇

- **热度**：85 points · 14 评论
- **原文**：https://www.iroh.computer/blog/an-iroh-powered-smart-fan
- **HN 讨论**：https://news.ycombinator.com/item?id=48817539

本文详细介绍如何使用iroh（P2P网络库）和ESP32微控制器构建一个无云端的智能风扇，通过DHT22温湿度传感器和PWM风扇控制，配合WebAssembly GUI实现全球远程访问。还包括3D打印外壳设计，并讨论了协议演进、认证和继电器中继等进阶话题。

HN评论中，有人质疑使用如此复杂工具链的实用性，认为红外遥控方案更简单直接。也有评论解释iroh的P2P能力才是核心，通过ESP32维持持久连接实现全球可控。部分评论欣赏“为什么不做”的黑客精神。

## 6. 住宅代理与爬虫问题的最新进展

- **热度**：175 points · 168 评论
- **原文**：https://lwn.net/SubscriberLink/1080822/990a8a5e2d379085/
- **HN 讨论**：https://news.ycombinator.com/item?id=48864252

LWN文章深入分析了AI训练数据爬虫的最新动向。爬虫流量主要来自通过恶意软件或“免费VPN”控制的家用设备（住宅代理），规模庞大且难以拦截。作者讨论了Proof-of-Work、CAPTCHA等防御措施的局限性，并指出真正的威胁可能来自政府或秘密AI项目。Google已联合FBI打击了NetNut等代理网络。

HN评论认为PoW对住宅代理无效，爬虫可利用被控设备免费计算；CAPTCHA更恼人。有人呼吁建立更好的公共爬虫库以减少边际优势。也有评论指出恶意爬虫与善意爬虫（如Internet Archive）应当区分对待，并质疑高频重复爬取的实际用途。

## 7. 现代应用认证的最佳方式是什么？

- **热度**：25 points · 6 评论
- **原文**：https://neciudan.dev/most-secure-way-to-store-auth-token
- **HN 讨论**：https://news.ycombinator.com/item?id=48869243

文章全面对比了token存储方案：localStorage易被XSS窃取；内存变量不能持久化；httpOnly cookie配合CSRF防护（CSRF Token、SameSite、Sec-Fetch-Site）是当前最佳实践，并推荐使用服务器端会话替代JWT以实现即时撤销。对于OAuth，建议采用Backend-for-Frontend（BFF）模式将令牌完全隐藏在服务器端。最后介绍了设备绑定会话凭据（DBSC）以防御信息窃取者。

HN评论存在分歧：一方认为localStorage足够安全且简单，cookie规范复杂容易出错；另一方支持传统cookie认证，认为成熟框架已验证其可靠性。部分评论批评文章可能是AI生成的“废话”，而另一些则认可其详细程度和BFF架构的价值。

## 8. SpaceX计划再发射10万颗星链卫星以实现百倍带宽

- **热度**：163 points · 494 评论
- **原文**：https://www.zdnet.com/home-and-office/networking/spacex-wants-to-launch-100000-more-starlink-satellites/
- **HN 讨论**：https://news.ycombinator.com/item?id=48863064

SpaceX向FCC申请部署10万颗第三代（Gen3）星链卫星，每颗重超2吨，需由星舰发射。目标提供亚20ms延迟的多千兆对称宽带，并服务AI设备。频谱请求涵盖Ku至D波段，可能引发干扰争议。天文界强烈反对，认为将严重影响观测。若获批，将彻底改变卫星宽带格局。

HN评论集中在星链对夜空视觉的影响，有用户表示看到卫星“星星”感到悲伤。也有评论指出光纤仍是城市最佳选择，星链主要服务农村和移动场景。讨论还涉及Starlink的容量密度限制（每平方英里仅6-7户），以及Reflect Orbital等太空镜面项目。部分用户认为全球手机直接连接卫星才是真正的变革。

## 9. 好的工具应该是无形的

- **热度**：405 points · 192 评论
- **原文**：https://www.gingerbill.org/article/2026/07/10/good-tools-are-invisible/
- **HN 讨论**：https://news.ycombinator.com/item?id=48858121

作者以文本编辑器、终端 vs GUI、Linux桌面等例子，批判将工具缺陷美化为“解谜游戏”的工程师文化。主张工具应消失在背景中，拥有良好默认值，避免用户身份绑定和沉没成本效应。真正的生产力靠实际时间衡量而非“聪明感”。

HN大量评论赞同核心观点，尤其是内部工具设计应聚焦用户成功路径。但部分评论指出“无形”是熟练度的自然结果，初学者阶段摩擦不可避免；复杂工具（如ARP 2600合成器）的灵活性是必要代价。也有评论认为作者混淆了熟悉度与优越性，资深用户经多年训练能让任何复杂工具变得无形。

## 10. 内燃机网页模拟器

- **热度**：159 points · 65 评论
- **原文**：https://combustionlab.net
- **HN 讨论**：https://news.ycombinator.com/item?id=48795900

一个在线内燃机模拟工具，用户可调整缸数、排量、压缩比、涡轮等参数，并查看功率曲线。但原文页面未提供详细原理说明，HN讨论指出其数值准确性存疑，超跑预设仅200马力明显不合理，且“工作原理”页面疑似AI生成。

HN评论中，有用户推荐更精准的引擎模拟项目（如AngeTheGreat的YouTube系列、ciechanow.ski的可视化文章），并对比了Revell Visible V8等经典模型。多数评论批评该工具为AI草稿，缺乏物理验证，可能导致误导。
