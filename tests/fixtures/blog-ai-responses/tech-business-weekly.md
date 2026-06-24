## 本周大事件

### [EU opens formal investigation into app store platform rules](https://www.theverge.com/2099/1/4/eu-app-store-platform-rules)

欧盟对应用商店平台规则启动正式调查，核心不是某个按钮改名，而是支付、导流和第三方市场准入会直接影响开发者分发成本。受影响最大的是依赖移动生态获客的 SaaS、游戏和订阅服务。风险在于监管周期长，短期规则可能反复摇摆；企业不应立刻重构商业模式，但要准备多渠道支付和合规审计方案。

### [NVIDIA expands AI data center supply commitments](https://blogs.nvidia.com/blog/ai-data-center-supply-commitments)

NVIDIA 扩大 AI 数据中心供应承诺，把 GPU、网络和企业部署支持一起打包，说明芯片竞争正在从单卡性能转向整套基础设施交付。云厂商、模型公司和大型企业采购团队会直接受影响，因为可用产能、交付周期和网络配套会决定 AI 项目上线速度。不确定性在于供应链和出口政策仍可能改变区域可用性。

### [CISA warns of active exploitation in enterprise identity products](https://www.cisa.gov/news-events/alerts/2099/01/03/enterprise-identity-exploitation)

CISA 将多个企业身份产品漏洞加入已利用目录，说明攻击面继续集中在身份系统和访问控制层。对企业来说，这类事件比普通组件漏洞更危险，因为身份产品一旦失守，会影响云账号、内部应用和供应链权限。受影响团队应优先看补丁窗口、临时缓解和凭证轮换；风险是补丁之外仍可能存在横向移动痕迹。

## 公司与平台

### [Cloudflare changes platform pricing for Workers AI enterprise customers](https://blog.cloudflare.com/workers-ai-enterprise-pricing)

Cloudflare 调整 Workers AI 企业客户的价格和治理控制，信号在于边缘平台开始把 AI 推理纳入正式企业采购框架。影响对象是已经在 Workers 上跑业务、又想把模型调用放在边缘侧的团队。好处是账号级限制和策略配置更清楚；风险是平台绑定更深，后续成本模型和配额规则会影响架构选择。

### [Amazon expands technology procurement tools for enterprise AI](https://www.aboutamazon.com/news/technology/enterprise-ai-procurement-tools)

Amazon 扩展企业 AI 采购工具，重点是集中采购控制和部署报告。这类变化不性感，但对大企业落地很关键：AI 工具从部门试点进入统一采购后，预算、权限、审计和供应商管理会成为主要门槛。适合大型组织采购、法务和平台团队观察；不确定性在于这些控制能否覆盖多云和第三方模型生态。

### [OpenAI launches enterprise admin controls for model routing](https://openai.com/news/enterprise-admin-controls-model-routing)

OpenAI 推出企业级模型路由、审计日志和 workspace 策略配置，说明模型服务正在变成可治理的企业平台，而不是单一 API。影响最大的是需要统一管理多个团队、多个模型和敏感数据边界的公司。风险是管理能力越强，配置错误的代价也越高；企业需要把模型路由纳入变更管理，而不是让业务团队随意切换。

## 政策、监管与安全

### [GitHub tightens rules for public package provenance](https://github.blog/open-source/package-provenance-rules)

GitHub 收紧公开包 provenance 规则，会影响包签名、构建元数据和维护者发布流程。它的重要性在于开源供应链信任正在从“相信维护者账号”转向“验证构建过程”。受影响的是库作者、包管理平台和依赖大量开源组件的企业。风险在于短期会增加维护成本，但长期能减少伪造发布和被劫持构建带来的安全事故。

### [Ars Technica reports chip export controls reshaping cloud capacity planning](https://arstechnica.com/information-technology/2099/01/chip-export-controls-cloud-capacity)

芯片出口管制正在改变云容量规划，影响不只在芯片厂，也会落到区域 GPU 可用性、客户承诺和模型训练排期上。对跨区域运营的 AI 公司，容量不再只是价格问题，还包含合规、交付和供应连续性。风险是政策变化难以预测，企业需要准备多区域部署和替代算力方案，而不是把关键路径押在单一供应区域。

### [WIRED Business analyzes antitrust pressure on AI default distribution](https://www.wired.com/story/ai-default-distribution-antitrust-pressure)

监管机构开始审视浏览器、手机和办公套件里的 AI 默认分发交易，说明 AI 入口竞争已经进入反垄断视野。影响对象包括模型公司、平台方和依赖默认入口获客的应用。商业风险在于默认分发可能被限制或附加条件，导致流量成本重新定价。还不确定的是监管会限制独占协议，还是要求更明确的用户选择权。

## 市场与商业信号

### [The Hacker News reports supply-chain attack targeting developer tools](https://thehackernews.com/2099/01/developer-tools-supply-chain-attack.html)

开发者工具更新通道被供应链攻击盯上，说明攻击者仍在寻找高杠杆入口：一次污染工具链，就可能影响多个组织的代码、凭证和部署系统。受影响的不只是安全团队，也包括 DevOps、平台工程和开源维护者。风险在于事件响应必须覆盖密钥轮换、构建环境审计和依赖锁定；只卸载受影响工具通常不够。

### [MIT Technology Review tracks public-sector AI procurement rules](https://www.technologyreview.com/2099/01/01/public-sector-ai-procurement-rules)

公共部门 AI 采购规则开始强调风险评估、透明度和供应商报告，这会改变 AI 公司卖给政府和大型机构的方式。影响对象是做政务、医疗、教育和公共服务项目的厂商。商业机会存在，但门槛也更高：模型能力之外，解释、审计、数据处理和责任边界会成为合同条件。不确定性在于各地区规则可能碎片化。

## 值得继续观察

### [The Register covers enterprise cloud outage contract changes](https://www.theregister.com/2099/01/01/cloud_outage_contract_changes)

企业云客户在连续平台事故后重新谈判故障条款和支持合同，说明云服务采购正在从“只看价格和功能”转向“明确停机责任”。影响最大的是金融、医疗、电商和高可用业务。后续要观察云厂商是否给出更透明的赔付、RTO/RPO 和故障沟通机制；风险是合同改善不一定等于架构韧性提升。

### [TechCrunch reports strategic AI platform consolidation](https://techcrunch.com/2099/01/04/strategic-ai-platform-consolidation)

AI 平台整合继续发生，真正的商业信号不是谁又发布一个功能，而是客户采购正在从多个点状工具转向少数平台组合。受影响的是中小 AI 工具公司、企业采购团队和云市场。风险在于整合会降低集成成本，也可能压缩独立厂商的议价空间。后续要观察客户是否愿意为统一治理牺牲一部分最佳单点能力。

这类信号应该持续放进周刊，但不能写成价格判断或采购指令，只记录产业结构变化和工程组织会受到的约束。
