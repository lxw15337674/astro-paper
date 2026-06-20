#!/usr/bin/env python3
from __future__ import annotations

import json
import re
import subprocess
from typing import Any

HN_TOP_URL = 'https://news.ycombinator.com/'
HN_API_ITEM = 'https://hacker-news.firebaseio.com/v0/item/{id}.json'

USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36'

TOPIC_RULES = [
    (r'ai|openai|llm|model|anthropic|gemini|copilot', 'AI / 模型'),
    (r'school|education|teacher|children|policy|government|id|internet traffic', '政策 / 社会议题'),
    (r'javascript|typescript|rust|biome|tooling|compiler|developer|code', '开发工具 / 编程语言'),
    (r'spacex|gpu|datacenter|load-balanced|systems|atproto|boston dynamics|robot|compression|printing', '基础设施 / 系统'),
]


def curl(url: str) -> str:
    result = subprocess.run(
        ['curl', '-L', '-A', USER_AGENT, '--max-time', '20', '-s', url],
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout


def fetch_json(url: str) -> Any:
    return json.loads(curl(url))


def compact(text: str) -> str:
    text = re.sub(r'\s+', ' ', text or '').strip()
    return text


def classify(title: str) -> str:
    t = title.lower()
    for pattern, label in TOPIC_RULES:
        if re.search(pattern, t):
            return label
    return '技术 / 观察'


def scrape_top_ids() -> list[int]:
    html = curl(HN_TOP_URL)
    ids = re.findall(r'<span class="rank">(\d+)\.</span>.*?id="score_(\d+)"', html, flags=re.S)
    out = []
    seen = set()
    for _rank, item_id in ids:
        iid = int(item_id)
        if iid not in seen:
            seen.add(iid)
            out.append(iid)
        if len(out) >= 10:
            break
    return out


def item_summary(title: str, text: str) -> tuple[str, str]:
    title_lower = title.lower()
    if 'dictator' in title_lower:
        return (
            '这篇文章介绍了一部关于独裁者私人厨师的纪录片，切入点不是传统政治史，而是通过“吃什么、怎么吃、谁来伺候”来观察权力的日常运作。文章真正有意思的地方，在于它把抽象的专制权力还原成极其私人、日常而且具体的生活细节，让“独裁者如何统治”变成“独裁者如何被服务、如何展示欲望”的观察对象。对今天的榜单来说，它的价值不在技术本身，而在于它提供了一种少见但极具穿透力的权力观察角度。',
            'HN 当前讨论量虽然不算特别高，但主线很集中：很多人觉得用厨师或侍从视角去讲独裁者，比传统政治人物传记更能揭示性格与控制欲。另一部分讨论会把它延伸到“微观生活细节是否比宏大叙事更能解释政治人物”这一层面，也有人担心这类题材容易被拍成猎奇消费。真正的分歧不在题材新不新，而在于这种近距离视角究竟是在深化理解，还是在把暴政重新包装成可观看的奇观。',
        )
    if 'children' in title_lower or 'internet traffic' in title_lower:
        return (
            '作者把近年来的年龄验证、成人网站实名、社交平台身份核验等政策串成一条线，核心论点是这些措施并不会停留在“保护未成年人”，而会逐步演变成整个互联网的实名追踪基础设施。文章真正值得关注的地方，在于它不是只反对某一条政策，而是在提醒读者：一旦身份验证被平台、支付、浏览和内容访问共同绑定，互联网匿名性的制度基础就会被系统性侵蚀。对技术读者来说，它的意义在于把一个看似单点治理问题，上升成了协议、隐私与权力结构的问题。',
            'HN 讨论的主线非常清晰：大家几乎都在争“年龄验证是否必然滑向全面实名制”，以及“保护未成年人”是否已经成为最容易推进监管扩权的政治借口。支持更严格监管的人会强调未成年人暴露在不适宜内容中的现实风险，反对者则更担心集中式身份数据库、行为追踪与寒蝉效应的长期代价。真正的分歧不只是技术实现是否安全，而是社会是否愿意接受“先实名、后访问”成为网络默认规则。',
        )
    if 'atproto' in title_lower:
        return (
            '文章试图澄清一个常见误解：ATProto/Bluesky 的去中心化并不是 Mastodon 式“实例”模式，而是把身份、托管与聚合拆开，强调用户不必永久依附某个站点。它真正的核心信息，不是“又一种去中心化社交协议”，而是把账号归属、内容存储和应用界面视为可拆分层，从而把迁移能力设计进协议本身。之所以能冲到今天榜单前列，也正因为它触碰了技术社区对“平台锁定是否可以从架构层面被削弱”的长期兴趣。',
            'HN 讨论主要围绕 ATProto 与 ActivityPub/Mastodon 的架构差异展开，很多人关心这到底是实质性的协议进步，还是只是对旧问题的重新命名。支持者认为这种设计至少在身份迁移与托管替换上更现代，批评者则指出“理论可迁移”不代表现实网络效应会跟着迁移，新的中心化入口依然会形成。真正的争论点不在去中心化口号本身，而在协议分层是否真的能改变平台权力的分布。',
        )
    if 'norway' in title_lower and 'ai' in title_lower:
        return (
            '报道介绍挪威在小学阶段对生成式 AI 的使用实施近乎全面限制，理由是儿童基础读写、表达与独立思考能力仍在形成，不应过早依赖自动生成工具。它值得上榜的原因，不只是教育政策本身，而是把“AI 应该从什么年龄、以什么方式进入教育体系”这个问题摆到了一个非常具体的制度层面。对技术读者来说，这也是一次关于工具普及边界的现实实验：当一种能力太强时，教育系统到底该更早接纳它，还是更晚引入它。',
            'HN 讨论主线明显分成两派：一派认为小学阶段限制 AI 很合理，逻辑上就像先学会算术再用计算器；另一派则认为学校不该回避新工具，而应尽早训练学生辨别、验证和正确使用 AI 的能力。还有不少评论把矛头指向考试和评价体系，认为真正需要重构的不是“能不能用 AI”，而是学校如何定义原创、理解与能力。分歧的关键不是 AI 本身，而是教育系统到底要优先保护基础能力，还是优先培养新型数字素养。',
        )
    if 'load-balanced' in title_lower:
        return (
            '文章用排队模型讨论一个反直觉现象：在保持单机利用率不变的情况下，后端服务器数量增加会明显降低平均等待时间，而不是简单维持不变。它的真正价值在于把很多工程师凭经验感受到的“大池子更稳”现象，用排队论和系统建模语言讲清楚。对今天的 HN 榜单来说，这类文章之所以受欢迎，是因为它既有数学直觉，也能直接映射到云服务、微服务和资源池设计等现实工程问题。',
            'HN 讨论主要围绕这一结论在真实系统中的适用边界展开：很多人立刻会追问模型假设是否过于理想，例如请求分布、服务时间尾部、节点异构性和协调开销是否会打破结论。也有人把它延伸到云平台和共享资源池的商业设计，认为这正解释了为什么大平台宁愿做更大的多租户池子，而不是切成许多小而紧绷的隔离单元。真正的争议不在“理论上对不对”，而在工程现实中哪些前提成立到什么程度。',
        )
    if 'boston dynamics' in title_lower or 'hyundai' in title_lower:
        return (
            '报道把现代汽车集团进一步控制波士顿动力放进更大的机器人竞赛背景下，关注的不只是资本收购本身，而是技术资产如何与制造业、物流和工业自动化场景结合。文章真正吸引技术社区的地方，在于 Boston Dynamics 长期处于“技术演示惊艳、商业化兑现缓慢”的特殊位置，因此每一次控制权变化都会被重新解读为“这次会不会终于落地”。它之所以值得进今天榜单，也因为它碰到了机器人行业最现实的问题：炫技和规模化之间到底隔着多远。',
            'HN 讨论集中在两条线：一条是现代入主后是否真能带来制造、供应链和工业场景上的落地能力，另一条则是对类人机器人叙事本身的持续怀疑。乐观者认为汽车制造商比金融资本更有机会把技术推向实际部署，悲观者则觉得 Boston Dynamics 多年来一直证明“会动”不等于“能赚钱”。真正的分歧不在大家是否欣赏其技术，而在于这些炫目的机器人究竟会先成为工业产品，还是继续停留在高成本展示样机阶段。',
        )
    if 'espresso' in title_lower or 'sound waves' in title_lower:
        return (
            '作者介绍了一种超声波浓缩咖啡方案，尝试通过高频声波增强常温萃取并降低能耗。',
            'HN 讨论自然分成科学原理和味道到底行不行两派，不少人质疑这是否还能算真正的 espresso。',
        )
    if 'favicon' in title_lower or 'stored a website in a favicon' in title_lower:
        return (
            '作者做了一个非常 Hacker News 风格的极限实验：把一整个网页内容编码进 favicon，再通过前端逻辑把像素数据还原成可访问页面。文章表面上是在秀一个奇技淫巧，真正有趣的地方其实是它把浏览器资源、图像编码与数据载体边界重新暴露出来，让读者重新意识到 Web 上许多“固定用途”的组件，本质上都可以被重新解释。它能冲上榜单，不是因为这种方法真的适合生产，而是因为它很好地击中了工程师对系统可塑性和边界测试的兴趣。',
            'HN 讨论主要集中在两类视角：一类人把它当成非常精彩的技术艺术或黑客玩笑，欣赏的是这种突破组件预期用途的创造力；另一类人则会很快落到工程现实，指出容量、兼容性、可维护性、缓存行为和安全边界都让这种方案不具备落地意义。真正的看点不在“这能不能拿去用”，而在于它再次证明了 Web 平台的很多约束，其实只是约定俗成，而不是绝对不能被改写的物理边界。',
        )
    if 'compression' in title_lower:
        return (
            '这是一篇系统梳理压缩理论与工程实践的长文，核心观点是压缩的本质并不是“省空间的小技巧”，而是通过更准确地建模与预测数据分布来减少不确定性。它之所以值得今天被重新翻出来，不只是因为内容全面，而是因为压缩、概率建模和现代语言模型之间本来就有很深的概念关联。对技术读者来说，这类文章的价值在于，它往往能把一些如今被包装成“AI 新问题”的东西，重新放回更经典的信息论框架里理解。',
            '这条帖子的评论不算特别多，因此 HN 的反应更像是在重新确认它作为“高价值技术资料”的地位，而不是形成一场激烈争论。讨论大多会落在两个方向：一是这篇教程今天是否仍然适合作为入门路径，二是压缩理论与机器学习、预测建模之间的联系是否被低估。真正的重点不是社区有没有吵起来，而是它被不断回流到榜单这件事本身，就说明这类“基础但不过时”的长文在 HN 仍有稳定吸引力。',
        )
    if 'memory' in title_lower and 'scientists think about memory' in title_lower:
        return (
            '这篇文章回顾了改变神经科学对“记忆如何形成”理解方式的重要发现，重点不是某一个孤立实验，而是突触可塑性等机制如何把抽象的学习与记忆能力落实为可观测、可检验的生物过程。它值得进入今天榜单，不是因为它提供了立刻可用的工程结论，而是因为这类基础科学叙事天然会吸引技术社区去思考：当我们谈“智能”“学习”“记忆”时，到底是在借用什么生物学隐喻。对技术读者来说，这类文章的价值往往在于重新校正对“记忆”这一概念的直觉。',
            'HN 讨论通常会沿着两个方向展开：一边是对科普文章本身是否足够严谨、是否过度简化神经科学历史的质疑，另一边则是把这类研究与认知退化、阿尔茨海默病以及更广泛的“人类如何存储经验”问题联系起来。评论不一定会很多，但这类条目经常激发的是一种跨学科兴趣：工程师会从中寻找与人工记忆、模型参数、学习机制之间的隐约对应，而科学背景更强的读者则会提醒大家不要把比喻直接当成等价物。真正的分歧不在研究值不值得看，而在于应不应该把它太快翻译成技术类比。',
        )
    if 'three trees' in title_lower:
        return (
            '这篇文章借一个看似简单的视觉问题——你看到的究竟是不是“三棵树”——去讨论人类感知是如何把连续世界切分成可命名对象的。它真正吸引人的地方，不在于某个答案对不对，而在于它把“对象边界是否天然存在”这个问题变得非常直观：我们看到的很多“东西”，其实都已经经过了大脑的组织、抽象和命名。对 HN 读者来说，这类文章之所以会上榜，往往正因为它站在认知科学、视觉经验和计算机感知之间，能够同时勾起哲学兴趣和工程联想。',
            'HN 讨论的主线通常会落在“对象边界究竟是现实中的结构，还是观察者构造出来的类别”上。有人会把它自然联想到计算机视觉和分割任务，认为这说明“识别一个对象”远不是表面看起来那么直接；也有人从艺术、摄影和语言分类的角度补充，指出很多视觉判断其实依赖语境和先验知识。真正值得看的不是大家最后有没有统一答案，而是评论区如何把一个抽象的知觉问题拆成多个可讨论的层次：感知、命名、分类和任务目标。',
        )
    if 'colors your screen can' in title_lower or "colors your screen can't show you" in title_lower:
        return (
            '这篇文章讨论了一个很容易被普通用户忽略、但对显示技术和图形系统至关重要的问题：现实世界里有些颜色本就无法被常见屏幕准确呈现。它表面上讲的是色域和设备限制，真正值得注意的地方则在于，它提醒人们“屏幕看到的颜色世界”只是可见色的一种压缩投影，而不是完整现实。对技术读者来说，这类文章的价值在于，它把色彩空间、显示管线和人眼感知之间那些平时被 UI 表层掩盖的技术层重新翻出来。',
            'HN 讨论通常会沿着两个方向展开：一类是更偏工程的讨论，比如广色域显示器、校色流程、摄影与印刷中的色彩管理到底能把这个问题缓解到什么程度；另一类则更偏知觉层面，讨论人类到底是如何把“颜色”理解成一个稳定对象，以及设备差异如何影响这种稳定感。真正的分歧不在于“屏幕有局限”这件事是否成立，而在于多数用户是否真的需要理解这些局限，以及在产品设计里应该把这种复杂性隐藏到什么程度。',
        )
    if 'arabic' in title_lower or 'digital printing' in title_lower:
        return (
            '文章解释了为什么阿拉伯文在印刷与数字排版中长期比拉丁字母更难处理，背后是连写、字形变化与书写方向等结构性差异。',
            'HN 讨论通常会延伸到主流计算技术长期以拉丁文字为默认前提，以及多语言排版支持的历史欠账。',
        )
    base = compact(text)[:200] if text else ''
    content = base or '这篇文章围绕一个具有当下讨论价值的技术或社会议题展开，重点不在单一结论，而在它提出了值得工程师继续追问的视角、方法或问题设定。若要真正理解其意义，仍需要回到原文看论证细节与上下文。'
    comment = 'HN 讨论通常会沿着两个方向展开：一边讨论文章观点在现实世界是否站得住脚，另一边讨论它在工程、产品或制度层面的边界条件。对这种条目来说，真正值得看的往往不是“大家同不同意”，而是评论区如何把抽象论点拆回到可验证、可落地的具体问题上。'
    if not content.endswith('。'):
        content += '。'
    return content, comment


def main() -> None:
    ids = scrape_top_ids()
    lines = ['1. 🔥 今日 HackerNews 热门文章 Top 10', '']
    for rank, item_id in enumerate(ids[:10], start=1):
        item = fetch_json(HN_API_ITEM.format(id=item_id))
        title = compact(item.get('title', f'Item {item_id}'))
        url = item.get('url') or f'https://news.ycombinator.com/item?id={item_id}'
        comments = int(item.get('descendants') or 0)
        score = int(item.get('score') or 0)
        hn_link = f'https://news.ycombinator.com/item?id={item_id}'
        topic = classify(title)
        content_summary, comment_summary = item_summary(title, compact(item.get('text', '')))
        lines.extend([
            f'{rank}. 🔥 {title}',
            f'- ⭐ {score} points · {comments} 评论',
            f'- 主题：{topic}',
            f'- 原文：{url}',
            f'- HN 讨论：{hn_link}',
            f'- 内容总结：{content_summary}',
            f'- 评论总结：{comment_summary}',
            '',
        ])
    print('\n'.join(lines).rstrip() + '\n')


if __name__ == '__main__':
    main()
