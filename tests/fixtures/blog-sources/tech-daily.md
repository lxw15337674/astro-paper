# 技术工程日报候选源

日期：2099-01-02
候选数量：3

## 1. PostgreSQL 19 beta adds planner improvements

- 链接：https://example.com/postgresql-19-beta
- 分类：数据库 / 查询规划
- 摘要：PostgreSQL 19 beta 增加 planner 改进和扩展接口调整，影响复杂 SQL、索引选择和扩展兼容性。迁移前需要用真实查询集验证计划稳定性、延迟尾部和回滚路径。

## 2. Kubernetes v1.35 tightens image provenance defaults

- 链接：https://example.com/kubernetes-135-provenance
- 分类：云原生 / 供应链安全
- 摘要：Kubernetes v1.35 收紧镜像 provenance 默认行为，影响 CI/CD、镜像仓库、准入策略和第三方 chart。升级窗口需要提前清理老镜像、临时镜像和例外发布流程。

## 3. Cloudflare publishes postmortem for edge routing incident

- 链接：https://example.com/cloudflare-routing-postmortem
- 分类：架构 / 事故复盘
- 摘要：Cloudflare 发布边缘路由事故复盘，重点是配置扩散、回滚速度和观测缺口。工程启发包括分阶段发布、自动熔断、跨区域验证和配置系统回滚演练。
