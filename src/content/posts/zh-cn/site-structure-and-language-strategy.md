---
author: bhwa233
pubDatetime: 2026-06-19T00:10:00Z
modDatetime: 2026-06-19T00:10:00Z
title: 这个博客的内容结构和语言策略
featured: false
draft: false
tags:
  - configuration
  - i18n
description: 这篇文章说明中文默认、英文保留的内容组织方式，以及后续如何继续扩展。
---

这个博客采用的是“中文默认，英文保留”的组织方式。

## 路由约定

- 中文页面直接使用根路径，例如 `/posts/...`
- 英文页面使用 `/en/...`

这样做的好处是，中文访问路径更短，也更符合这个站点当前的主要受众。

## 内容组织方式

文章会按语言分别存放：

```text
src/content/posts/zh-cn/...
src/content/posts/en/...
```

页面内容也是同样的思路：

```text
src/content/pages/zh-cn/about.md
src/content/pages/en/about.md
```

## 这样做带来的结果

- 中英文文章可以独立维护
- 标签和分页不会把两种语言混在一起
- RSS 可以分别输出不同语言的内容

后面如果需要增加更多语言，也可以继续沿用这个结构。
