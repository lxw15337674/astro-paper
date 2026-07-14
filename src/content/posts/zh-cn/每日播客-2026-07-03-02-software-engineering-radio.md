---
author: bhwa233
pubDatetime: 2026-07-02T16:00:00Z
modDatetime: 2026-07-03T05:32:12Z
title: "Software Engineering Radio (Episode 727)：数据工程新宠：Polars 高性能数据处理框架深度解析"
featured: false
draft: false
tags:
  - 播客
ogImage: "../../../../public/images/podcast/2026-07-03-02-software-engineering-radio.webp"
description: "每日海外 Podcasts 热门节目中文长文笔记。"
timezone: Asia/Shanghai
---

## 数据工程新宠：Polars 高性能数据处理框架深度解析

### 中文主题

Polars 框架在 Python 数据处理中的设计哲学、核心技术与工程实践指南

### 基本信息

- **节目**：Software Engineering Radio (Episode 727)
- **嘉宾**：Jeroen Janssens（Posit 高级开发者关系工程师）、Thijs Nieuwdorp（Polars 开发者关系工程师）
- **日期**：2026-07-02
- **来源**：IEEE Computer Society
- **链接**：[SE Radio 727: Jeroen Janssens and Thijs Nieuwdorp on Using Polars](https://se-radio.net/2026/07/se-radio-727-jeroen-sanssens-and-thijs-nieuwdorp-on-using-polars/)

---

### 核心观点

Polars 不仅仅是一个“更快的 Pandas 替代品”，它是一个基于 Rust 构建、以 Apache Arrow 为底层内存标准，并通过声明式查询优化器驱动的全新数据流引擎。数据工程师在使用 Polars 时，需要从传统的命令式、基于索引（Index-based）的思维，转向声明式（Declarative）以及基于表达式（Expression-based）的思维模式。这种转变不仅能释放硬件的多核并行潜力，还能通过惰性求值（Lazy Evaluation）实现超越内存限制的大规模数据处理。

---

### Highlights

- **起源与痛点**：Polars 由 Ritchie Vink 创立，初衷是解决 Pandas 在多表关联（Join）等复杂操作上的极慢性能。它用 Rust 编写，旨在设计一个贴近底层硬件架构、无第三方依赖的高效数据框架。
- **Apache Arrow 的物理基石**：Polars 底层完全基于 Apache Arrow 列式内存格式，这使得它能够直接复用硬件的向量化执行能力，并与 Pandas (Arrow 后端)、PySpark 等生态实现零复制（Zero-copy）的数据互操作。
- **表达式驱动的声明式 API**：Polars 摒弃了 Pandas 复杂的方括号（`[]`）索引操作，引入了直观且可链式调用的表达式系统（如 `pl.col`）。这类似于 SQL 的声明式风格，允许底层优化器自动优化物理执行计划。
- **惰性求值与查询优化**：惰性求值允许 Polars 构建逻辑执行计划，并应用“谓词下推”（Predicate Pushdown）和“投影下推”（Projection Pushdown）等技术，将数据过滤和列选择直接下推至源头，大幅减少内存占用。
- **GPU 加速与流式处理**：Polars 与 NVIDIA 合作，通过 NVIDIA cudf 实现了无缝的 GPU 计算加速；同时其流式处理（Streaming）机制允许通过“外存”（Out-of-core）计算，利用硬盘缓存处理超出物理内存上限的超大型数据集。

---

### 长文笔记

#### 1. 为什么需要 Polars？从 Ritchie Vink 的痛点谈起

在数据科学与数据工程领域，Pandas 长期占据统治地位。然而，随着数据规模的指数级增长，Pandas 基于单核运行、内存占用过大（通常为源数据的 5-10 倍）以及在多表关联操作上的低效，逐渐成为生产环境的瓶颈。

Polars 的诞生源于其创始人 Ritchie Vink 的一次工程实践。大约五年前，Ritchie 在为客户合并两个超大型数据表时，发现 Pandas 的处理速度慢得令人无法接受。为了寻求突破，他决定利用 Rust 这门强调零成本抽象、内存安全且并发性能极强的语言，从零开始实现一个高性能的 Dataframe 库。

Polars 的核心设计原则是：**充分压榨硬件多核并行能力，且不依赖任何重量级的外部运行时。** 这使得 Polars 在轻量级部署（如 AWS Lambda 或本地脚本）中极具优势，而不需要像 Spark 那样启动复杂的 JVM 集群。

#### 2. Apache Arrow：奠定列式内存与生态互操作的基础

要理解 Polars 的速度为什么快，首先必须理解它与 Apache Arrow 的底层绑定。Apache Arrow 定义了一种用于内存计算的列式数据格式（Columnar Memory Format）。

- **列式存储与 CPU 缓存友好**：在传统行式内存存储中，同一行的不同字段在内存中连续排列；而在列式存储中，同一列的所有数据被连续存储。对于数据分析（如求某一列的平均值、过滤某列特征）而言，列式布局意味着 CPU 能够利用 CPU 缓存（L1/L2）连续读取数据，并通过单指令多数据流（SIMD）进行向量化并行计算。
- **零复制互操作性**：由于 Apache Arrow 已经成为高性能数据工具的事实标准，Polars 与其他兼容 Arrow 标准的库（例如新版 Pandas 的 Arrow 后端、PySpark、DuckDB）之间传递数据时，不需要进行昂贵的反序列化和数据拷贝，而是直接通过内存指针共享数据。

#### 3. 告别 Row Index：声明式表达式的设计哲学

许多从 Pandas 迁移到 Polars 的开发者面临的最大挑战是思维方式的转变。Pandas 的代码中充斥着显式的行索引（`df.index`、`df.loc`）和各种用于多维定位的方括号。

```python
# Pandas 风格：依赖索引与隐式的计算顺序
df[df['age'] > 30]['salary'].mean()
```

Polars 彻底摒弃了“行索引”的概念。在 Polars 的世界里，一切都是**表达式（Expressions）**。

```python
# Polars 风格：声明式、链式调用
df.filter(pl.col("age") > 30).select(pl.col("salary").mean())
```

- **表达式即逻辑树**：`pl.col("salary").mean()` 并不是立即执行计算的命令，它是一个用于描述“获取 salary 列并求其均值”的逻辑树节点。
- **链式调用的优越性**：Polars 推荐使用类似于 R 语言 Tidyverse（如 dplyr）或 SQL 的链式调用。这种“自上而下”的结构结构清晰，避免了中途产生大量的临时变量（如 `df1`, `df2`），极大地改善了代码的可读性，并利于物理引擎进行并行编排。
- **避免“搬石头砸自己的脚”**：Pandas 的 API 存在许多“暗坑”（Footguns），例如链式赋值导致的 `SettingWithCopyWarning`。Polars 通过不可变（Immutable）的数据设计和简洁的表达式接口，消除了这些容易导致线上故障的隐性陷阱。

#### 4. 惰性求值与查询优化：Polars 提速的核心秘诀

Polars 的 API 分为两种模式：**即时模式（Eager Mode）**和**惰性模式（Lazy Mode）**。

即时模式下，代码每写一行，底层就立即执行计算并返回结果，这与 Pandas 的行为一致。但在处理大规模数据时，强烈建议使用惰性模式。通过将数据源读取函数（如 `read_csv` 改为 `scan_csv`），或者在 Dataframe 上调用 `.lazy()` 方法，Polars 会将后续的所有操作拦截，并构建成一个**逻辑查询计划（Logical Plan）**，直到遇到 `.collect()` 才会真正触发物理计算。

惰性模式之所以强大，在于底层物理引擎会在 `.collect()` 执行前，利用查询优化器对逻辑计划进行重写：

##### 谓词下推（Predicate Pushdown）

如果你的查询中包含过滤条件（如 `filter(pl.col("country") == "US")`），优化器会将这个过滤动作尽可能推移到最前端。例如，在读取一个 10GB 的 CSV 文件时，Polars 不会将 10GB 完整载入内存再进行过滤，而是在读取文件分片的同时就应用过滤条件，只将符合条件的数据加载进内存，这能瞬间减少几个数量级的内存开销。

##### 投影下推（Projection Pushdown）

如果你的数据集有 100 列，但后续操作只用到了其中 3 列，优化器会确保物理读取器从一开始就忽略其余 97 列。对于 Parquet 这种天然支持列式读取的文件格式，投影下推能够节省大量的磁盘 I/O 和内存带宽。

#### 5. 内存之外的野心：流式处理与外存计算

对于小体量数据，内存计算速度的差异可能只是毫秒级与秒级的区别；但当数据量超过机器的物理内存上限（RAM）时，传统的 Pandas 会直接报 `OutOfMemory (OOM)` 错误崩溃，而 Spark 则需要昂贵的分布式集群支持。

Polars 引入了**流式处理引擎（Streaming Engine）**来解决这一痛点。当在执行 `.collect(streaming=True)` 时，Polars 会将超大文件切分为多个块（Chunks/Morsels），像流水线一样逐块拉入内存处理，完成局部计算后释放，从而维持极低的内存占用（Peak Memory）。

针对诸如“排序（Sort）”或“分组聚合（GroupBy）”这类必须获取全局数据才能输出结果的“阻塞型操作”，Polars 正在积极开发并完善 **溢写至磁盘（Spill-to-disk）** 功能。当物理内存不足以容纳排序所需的中间状态时，Polars 会将临时结果写入本地硬盘的临时文件中，牺牲一定的读写性能，以换取“任务不崩溃且最终跑通”的工程底线。

#### 6. 核心工程技巧：多表关联与类型优化

在实际的数据工程流水线中，有两个操作高频出现且极易导致性能劣化：多表关联（Join）和类别数据处理。

##### 关联操作的选择

Polars 实现了极速的哈希关联（Hash Join）。当两个表关联时，开发者可以选择不同的 Join 类型：

- **左关联（Left Join）**：保留左表所有行。如果右表缺少对应值，Polars 会填入 `null`。
- **内关联（Inner Join）**：仅保留左右表中完全匹配的记录。在 Polars 中，如果未匹配到，该行会被直接丢弃。

##### 类别（Categorical）数据类型优化

如果一列数据中包含大量重复的文本（例如城市名、衣服尺码、性别），将其存储为普通的字符串（String）会造成巨大的内存浪费和 CPU 比较开销。
Polars 提供了 `Categorical` 数据类型，其机制是在内存中维护一个映射表（字符串 $\leftrightarrow$ 整数索引）。在执行合并或过滤操作时，底层实际上只对整数（如 1, 2, 3）进行比较和传输，这能显著降低内存占用并成倍提升计算速度。

#### 7. 实践启示：何时从 Pandas 迁移，如何平滑过渡？

尽管 Polars 性能卓越，但并不意味着所有项目都应立刻重写。以下是针对工程实践的迁移建议：

- **迁移边界**：如果你的数据集小于 100MB，且现有 Pandas 代码运行良好，重写代码的工程成本可能大于性能收益。然而，一旦数据规模达到 GB 级别，或者数据流中存在频繁的多表 Join、复杂的 GroupBy 聚合，迁移到 Polars 将带来立竿见影的成本缩减（如降低云端计算实例的规格）。
- **渐进式重构**：无需一次性推翻所有代码。你可以利用 Apache Arrow 提供的无缝转换，在计算瓶颈处引入 Polars 处理，再通过 `.to_pandas()` 转换回原有流程。随着对表达式系统的熟悉，再逐步扩大 Polars 的控制范围。
- **生态融合**：Polars 与主流的可视化工具、数据库连接器高度兼容，可以轻松利用 `connectorx` 等库高速读取 SQL 数据库中的数据并转化为 Dataframe，形成闭环的高性能数据处理链路。
