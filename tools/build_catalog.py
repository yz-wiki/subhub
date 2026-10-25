#!/usr/bin/env python3
"""Build the built-in ruleset catalog from MetaCubeX/meta-rules-dat listings.

Usage on a machine with the three tree listings JSON:
    python3 build_catalog.py meta-geosite.json meta-geoip.json sing-geosite.json sing-geoip.json > ../gateway/seed/rules-catalog.json
"""
import json
import sys

RAW = "https://raw.githubusercontent.com/MetaCubeX/meta-rules-dat"

GROUPS = [
    ("🛑 广告拦截", ("ad-", "ads", "adblock", "porn", "telemetry", "tracker", "malware", "spam", "phishing")),
    ("📲 电报消息", ("telegram", "t.me")),
    ("🎥 奈飞视频", ("netflix", "nflx")),
    ("🎬 国外媒体", ("youtube", "disney", "hbo", "primevideo", "hulu", "twitch", "tiktok", "spotify",
                  "soundcloud", "media", "video", "music", "stream", "emby", "plex")),
    ("📺 国内媒体", ("bilibili", "douyin", "iqiyi", "youku", "weibo", "netease", "kuaishou", "tencent-video")),
    ("🤖 人工智能", ("ai", "openai", "chatgpt", "anthropic", "claude", "gemini", "copilot", "midjourney", "perplexity")),
    ("📢 谷歌服务", ("google", "gstatic", "gvt", "blogspot", "android")),
    ("🍎 苹果服务", ("apple", "icloud", "appstore", "itunes")),
    ("Ⓜ️ 微软服务", ("microsoft", "windows", "office", "onedrive", "bing", "msn", "xboxlive")),
    ("🎮 游戏平台", ("game", "steam", "epic", "sony", "playstation", "nintendo", "riot", "blizzard", "ea-", "ubisoft")),
    ("📦 下载服务", ("download", "update", "mirror")),
    ("🎯 全球直连", ("private", "lan", "local", "direct", "cn", "china", "geolocation-cn", "bilibili-cn",
                  "category-*-cn")),
]
CN_NAMES = {
    "cn", "china", "geolocation-cn", "geolocation-!cn", "category-ai-cn", "category-bank-cn",
    "category-blog-cn", "category-cdn-cn", "category-companies@cn", "category-documents-cn",
    "category-ecommerce@cn", "category-education-cn", "category-entertainment-cn", "category-food-cn",
    "category-games-cn", "category-media-cn", "category-mooc-cn", "category-netdisk-cn",
    "category-news-cn", "category-ntp-cn", "category-scholar-cn", "category-shopping-cn",
    "category-social-media-cn", "category-speedtest@cn",
}


def guess_group(name, kind):
    low = name.lower()
    if kind == "geoip":
        if low in ("cn", "private"):
            return "🎯 全球直连"
        return "🚀 节点选择"
    for group, keys in GROUPS:
        for key in keys:
            if key in low:
                return group
    return "🚀 节点选择"


def pretty(name, kind):
    if kind == "geoip":
        if len(name) == 2:
            return name.upper()
        if name in ("private",):
            return "Private"
        if name in ("cn",):
            return "China"
        return name
    # geosite: category-xxx -> Category xxx, google -> Google
    parts = name.split("-")
    return " ".join(p[:1].upper() + p[1:] for p in parts)


def entries(path, ext, kind):
    with open(path, encoding="utf-8") as fh:
        tree = json.load(fh)["tree"]
    out = []
    for item in tree:
        p = item["path"]
        if not p.endswith(ext):
            continue
        name = p[: -len(ext)]
        if not name or "/" in name:
            continue
        if kind == "geosite":
            urls = {
                "mihomo": f"{RAW}/meta/geo/geosite/{name}.mrs",
                "singbox": f"{RAW}/sing/geo/geosite/{name}.srs",
                "raw": f"{RAW}/meta/geo/geosite/{name}.yaml",
            }
            behavior = "domain"
        else:
            urls = {
                "mihomo": f"{RAW}/meta/geo/geoip/{name}.mrs",
                "singbox": f"{RAW}/sing/geo/geoip/{name}.srs",
                "raw": f"{RAW}/meta/geo/geoip/{name}.yaml",
            }
            behavior = "ipcidr"
        out.append({
            "id": ("gs:" if kind == "geosite" else "gi:") + name,
            "name": name,
            "label": pretty(name, kind),
            "kind": kind,
            "group": guess_group(name, kind),
            "behavior": behavior,
            "noResolve": behavior == "ipcidr",
            "urls": urls,
        })
    return out


def main():
    meta_gs, meta_gi, sing_gs, sing_gi = sys.argv[1:5]
    index = {}
    # sing branch carries the same names plus a few extra; merge by name.
    for path, ext, kind in ((meta_gs, ".mrs", "geosite"), (meta_gi, ".mrs", "geoip"),
                            (sing_gs, ".srs", "geosite"), (sing_gi, ".srs", "geoip")):
        for item in entries(path, ext, kind):
            index.setdefault(item["id"], item)

    items = sorted(index.values(), key=lambda x: (x["kind"], x["name"]))
    catalog = {
        "version": 1,
        "source": "MetaCubeX/meta-rules-dat (meta + sing branches)",
        "count": len(items),
        "items": items,
    }
    json.dump(catalog, sys.stdout, ensure_ascii=False, separators=(",", ":"))
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
