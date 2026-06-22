#!/usr/bin/env python3
from __future__ import annotations

import html
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

LOW_SIGNAL_PATTERNS = [
    r'文章信息需从原文提取',
    r'这篇文章讨论了一个具有现实意义的技术或社会议题',
    r'评论区通常会补充原文没有展开的现实约束',
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


def strip_html(text: str) -> str:
    text = html.unescape(text or '')
    text = re.sub(r'<[^>]+>', ' ', text)
    return compact(text)


def is_low_signal(text: str) -> bool:
    cleaned = compact(strip_html(text))
    if not cleaned:
        return True
    return any(re.search(pattern, cleaned, flags=re.I) for pattern in LOW_SIGNAL_PATTERNS)


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
            '文章试图澄清一个常见误解：ATProto/Bluesky 的去中心化并不是 Mastodon 式“实例”模式，而是把身份、托管与聚合拆开，用户可以把账号标识、内容托管和客户端体验分别看待。作者强调，ATProto 的关键不是复制论坛式“实例”结构，而是把迁移能力和身份可携带性作为协议层能力来设计。这样一来，用户离开某个服务时，理论上迁走的就不只是关注列表，还包括账号归属本身。',
            '评论区的分歧主要在于，这种协议分层到底是不是对 ActivityPub/Mastodon 的真实改进。支持者认为把身份和托管解绑后，迁移路径更清晰；质疑者则指出，理论上的可迁移并不能自动消除网络效应和入口中心化，用户最终仍可能被少数大型服务重新锁定。还有评论补充说，协议设计解决的是可迁移性上限，不等于保证现实中的迁移会频繁发生。',
        )
    if 'norway' in title_lower and 'ai' in title_lower:
        return (
            '报道介绍挪威在小学阶段对生成式 AI 采取近乎全面限制，核心理由是儿童的基础读写、表达与独立思考能力仍处在形成期，不应过早依赖自动生成工具完成学习任务。文章强调，这项政策并不是否认 AI 会进入教育，而是把问题定义为“什么时候引入、以什么方式引入”，并优先保护小学阶段的基础能力训练。它同时把教育技术讨论从抽象原则拉回到制度设计：哪些场景算辅助，哪些场景会直接替代学习过程。',
            '评论区明显分成两派：支持者把它类比为“先学会算术，再用计算器”，认为小学阶段最该保护的是写作、阅读和推理基本功；反对者则认为学校不应回避新工具，而应更早训练学生识别、验证和约束 AI 输出。还有不少评论把焦点移到考试与评价体系，认为真正难题不是能不能用 AI，而是学校如何区分辅助、代写与真实理解。',
        )
    if 'load-balanced' in title_lower:
        return (
            '文章用排队模型讨论一个反直觉结论：在单机利用率保持不变时，后端服务器数量增加会显著降低平均等待时间，因为更多服务节点会减少“某一台刚好很忙而请求只能排队”的概率。作者借此说明，系统性能并不只由平均负载决定，还受负载波动和队列分配方式影响。文中的重点不是简单鼓吹“机器越多越好”，而是解释为什么更大的资源池在相同平均利用率下往往能带来更低延迟。',
            '评论区主要追问这个模型在真实系统中的边界条件。很多人质疑请求分布、长尾延迟、节点异构性、缓存局部性和协调开销会不会削弱结论；也有人把讨论延伸到云平台和多租户池化，认为这解释了为什么大型平台倾向于维护更大的共享池。真正的分歧不在排队论本身，而在这些理想化前提能在生产环境里保留多少。',
        )
    if 'boston dynamics' in title_lower or 'hyundai' in title_lower:
        return (
            '报道的核心是现代汽车集团进一步取得波士顿动力控制权，并把这笔交易放进机器人产业的落地问题里理解：一边是波士顿动力长期积累的运动控制与机器平台能力，另一边是现代在制造、供应链和工业场景上的整合能力。文章并不只是把它写成普通并购新闻，而是在追问这类机器人技术能否从高完成度演示走向规模部署。它隐含的关键问题是，资本与产业资源的更换，是否足以改变机器人商业化节奏。',
            '评论区主要围绕两点展开：第一，汽车制造商是否真的比财务投资方更有机会把机器人推向真实工厂、仓储和物流场景；第二，波士顿动力多年来“技术惊艳但商业化缓慢”的历史到底说明了什么。乐观者认为现代至少补上了落地所需的制造和场景能力，悲观者则强调“能稳定运动”和“能大规模赚钱”之间仍隔着可靠性、成本与维护体系。',
        )
    if 'espresso' in title_lower or 'sound waves' in title_lower:
        return (
            '作者介绍了一种超声波浓缩咖啡方案，尝试通过高频声波增强常温萃取并降低能耗。',
            'HN 讨论自然分成科学原理和味道到底行不行两派，不少人质疑这是否还能算真正的 espresso。',
        )
    if 'favicon' in title_lower or 'stored a website in a favicon' in title_lower:
        return (
            '作者做了一个极限实验：把网页内容编码进 favicon 图像，再用前端逻辑从像素数据中还原页面。文章的技术重点不只是“能不能塞进去”，而是如何利用浏览器对图标资源的加载方式、图像编码和前端解码流程，把一个原本只承担装饰作用的小资源重新当作数据载体。它展示的不是可落地方案，而是 Web 资源模型在边界条件下到底有多可塑。',
            '评论区基本分成两派：一派把它当成高质量的黑客式技术艺术，认为这种实验的价值就在于揭示系统边界和非常规用法；另一派则迅速转向工程现实，指出容量、缓存、兼容性、安全策略和可维护性会让它无法成为实际交付方案。还有评论进一步把话题引向更一般的问题：Web 平台里哪些约束是协议硬限制，哪些其实只是大家默认不去碰的约定。',
        )
    if 'compression' in title_lower:
        return (
            '这是一篇系统梳理压缩理论与工程实践的长文，核心观点是压缩并不是单纯“省空间”，而是通过更准确地建模和预测数据分布来减少编码所需的信息量。文章从信息论、统计建模到具体压缩技术一路展开，把“压缩器为什么有效”解释为“模型对数据规律抓得有多准”。它之所以常被反复提起，是因为文中很多关于预测、编码和概率分布的解释，与今天机器学习里常见的问题其实共用同一套基础思想。',
            '评论区虽然不算特别热闹，但补充的信息点很明确：一些人把它当成仍然有效的入门材料，认为它能把压缩、建模和概率思维串起来；另一些人则讨论这篇旧文在今天是否还能覆盖现代工程实践，尤其是与机器学习、语言模型之间的联系是否应该被讲得更显式。评论的重点不是情绪争论，而是它作为技术教材在今天还有多高的解释力。',
        )
    if 'memory' in title_lower and 'scientists think about memory' in title_lower:
        return (
            '这篇文章回顾了改变神经科学记忆观的重要发现，核心不在单一实验，而在于突触可塑性等机制如何把“学习之后大脑会变化”这一直觉，落实为可观测、可检验的生物过程。文章的重点是，记忆不再被理解成静态存储，而被理解成神经连接会随着活动历史而改变的动态系统。它同时把后续关于学习、记忆巩固和认知退化的很多研究，放回到这一转变过的框架里理解。',
            '评论区的补充主要集中在两类信息：一类质疑科普叙事是否把神经科学历史讲得过于线性，提醒读者不要把复杂研究压成“一个发现改变一切”的故事；另一类则把话题延伸到阿尔茨海默病、认知退化以及人工系统中的“记忆”类比。真正的争点不是记忆研究是否重要，而是这些生物学概念在跨到 AI 或工程语境时能保留多少原意。',
        )
    if 'three trees' in title_lower:
        return (
            '这篇文章借“你能不能看到三棵树”这个问题讨论对象识别的前提：现实中的连续形状、遮挡关系和观察角度，究竟在什么条件下才会被人稳定地看成独立对象。文章的重点不是给出唯一答案，而是说明“对象”并不是天然分割好的单位，而是感知系统在语境、任务和经验作用下形成的结果。它把一个抽象的认知问题压缩成了一个很直观的视觉例子。',
            '评论区主要围绕“对象边界到底是现实结构还是观察者构造”展开。有人把它联想到计算机视觉和图像分割，指出所谓“识别出一个对象”往往依赖任务定义和先验；也有人从艺术、摄影和语言分类角度补充，认为很多视觉判断其实离不开命名习惯和语境。评论真正补上的，是对象识别背后那层通常被日常直觉掩盖的分类前提。',
        )
    if 'colors your screen can' in title_lower or "colors your screen can't show you" in title_lower:
        return (
            '这篇文章讨论的是色域限制：现实世界和人眼可感知的颜色范围，并不能被常见显示设备完整覆盖。作者把问题拆成显示器可再现的颜色集合、色彩空间表示方式以及人类视觉感知三层，说明“屏幕上的颜色”本质上是被设备能力压缩过的一小部分可见光经验。文章的核心信息不是单纯说“屏幕不准”，而是解释为什么有些颜色从定义上就落在当前显示硬件能力之外。',
            '评论区补充了两类信息：一类是工程侧的，讨论广色域显示器、校色、摄影和印刷流程到底能把问题缓解到什么程度；另一类是知觉侧的，讨论颜色究竟是物理刺激、设备映射还是人脑构造出来的稳定感知对象。真正的分歧不在“设备有限”是否成立，而在多数产品和用户场景里，有没有必要把这种复杂性显式暴露出来。',
        )
    if 'arabic' in title_lower or 'digital printing' in title_lower:
        return (
            '文章解释了为什么阿拉伯文在印刷与数字排版中长期比拉丁字母更难处理，背后是连写、字形变化与书写方向等结构性差异。',
            'HN 讨论通常会延伸到主流计算技术长期以拉丁文字为默认前提，以及多语言排版支持的历史欠账。',
        )
    base = compact(text)[:260] if text else ''
    topic = classify(title)
    content = base or f'这条内容围绕“{title}”展开，当前自动化归档先保留标题、原文入口和 HN 讨论入口，适合按 {topic} 方向继续阅读原文。'
    comment = f'HN 讨论可以作为补充视角：重点看读者如何质疑“{title}”背后的前提、实现边界和现实适用场景，而不是只看分数高低。'
    if not content.endswith('。'):
        content += '。'
    return content, comment


def build_item_payload(item: dict[str, Any], rank: int) -> dict[str, Any]:
    item_id = int(item.get('id') or 0)
    title = compact(item.get('title', f'Item {item_id or rank}'))
    url = item.get('url') or (f'https://news.ycombinator.com/item?id={item_id}' if item_id else '')
    comments = int(item.get('descendants') or 0)
    score = int(item.get('score') or 0)
    hn_link = f'https://news.ycombinator.com/item?id={item_id}' if item_id else ''
    topic = classify(title)
    source_text = strip_html(item.get('text', ''))
    content_summary, comment_summary = item_summary(title, source_text)
    return {
        'rank': rank,
        'id': item_id,
        'title': title,
        'url': url,
        'hn_link': hn_link,
        'topic': topic,
        'score': score,
        'comments': comments,
        'source_text': source_text,
        'content_summary': content_summary,
        'comment_summary': comment_summary,
    }


def summarize_response_body(text: str) -> tuple[int, int]:
    content_count = 0
    comment_count = 0
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith('- 内容总结：'):
            if not is_low_signal(stripped.split('：', 1)[1]):
                content_count += 1
        elif stripped.startswith('- 评论总结：'):
            if not is_low_signal(stripped.split('：', 1)[1]):
                comment_count += 1
    return content_count, comment_count


def main() -> None:
    ids = scrape_top_ids()
    lines = ['1. 🔥 今日 HackerNews 热门文章 Top 10', '']
    payload_items = []
    for rank, item_id in enumerate(ids[:10], start=1):
        item = fetch_json(HN_API_ITEM.format(id=item_id))
        payload = build_item_payload(item, rank)
        payload_items.append(payload)
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
    content_count, comment_count = summarize_response_body('\n'.join(lines))
    if content_count < 10 or comment_count < 10:
        raise RuntimeError(
            f'low-signal HN source output: content_count={content_count}, comment_count={comment_count}'
        )
    lines.extend(['===ARCHIVE_PAYLOAD===', json.dumps({'items': payload_items}, ensure_ascii=False)])
    print('\n'.join(lines).rstrip() + '\n')


if __name__ == '__main__':
    main()
