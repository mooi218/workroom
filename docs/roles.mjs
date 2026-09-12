export const DEFAULT_ROLES = [
  {
    id: "engineering",
    name: "エンジニア",
    en: "Engineering",
    color: "#5d80aa",
    keywords: [
      "実装",
      "バグ",
      "修正",
      "コード",
      "開発",
      "エラー",
      "テスト",
      "エンジニア",
      "構築",
      "監査",
      "デプロイ",
      "バックエンド",
      "api",
      "github",
      "deploy",
      "code",
      "bug",
      "engineer",
      "engineering",
      "refactor",
      "implementation",
      "backend",
      "frontend",
      "security",
      "integration",
      "qa",
      "test",
      "tests",
      "review",
    ],
  },
  {
    id: "design",
    name: "デザイン",
    en: "Design",
    color: "#b57c9a",
    keywords: [
      "デザイン",
      "画像",
      "イラスト",
      "ロゴ",
      "レイアウト",
      "スライド",
      "配色",
      "可視化",
      "design",
      "illustration",
      "figma",
      "ui",
      "ux",
      "visual",
      "visualization",
      "assets",
      "render",
    ],
  },
  {
    id: "pr",
    name: "広報",
    en: "Public relations",
    color: "#bc7e50",
    keywords: [
      "広報",
      "プレス",
      "告知",
      "sns",
      "x投稿",
      "発信",
      "ブランド",
      "press",
      "public relations",
      "announcement",
      "social",
    ],
  },
  {
    id: "sales",
    name: "営業",
    en: "Sales",
    color: "#b38c43",
    keywords: [
      "営業",
      "商談",
      "顧客",
      "見積",
      "提案書",
      "見込み客",
      "sales",
      "customer",
      "lead",
      "proposal",
      "crm",
    ],
  },
  {
    id: "writing",
    name: "編集・執筆",
    en: "Editorial",
    color: "#8a83b5",
    keywords: [
      "ブログ",
      "記事",
      "執筆",
      "文章",
      "校正",
      "翻訳",
      "ニュースレター",
      "原稿",
      "編集部",
      "blog",
      "article",
      "write",
      "writing",
      "newsletter",
      "copywriting",
      "editorial",
      "content",
      "docs",
    ],
  },
  {
    id: "research",
    name: "リサーチ",
    en: "Research",
    color: "#639b92",
    keywords: [
      "調査",
      "比較",
      "分析",
      "論文",
      "リサーチ",
      "検証",
      "調べ",
      "research",
      "analysis",
      "analyze",
      "compare",
      "investigate",
      "audit",
      "evidence",
    ],
  },
  {
    id: "planning",
    name: "企画",
    en: "Planning",
    color: "#839563",
    keywords: [
      "企画",
      "戦略",
      "計画",
      "ロードマップ",
      "要件",
      "planning",
      "strategy",
      "roadmap",
      "requirements",
    ],
  },
  {
    id: "operations",
    name: "運営・事務",
    en: "Operations",
    color: "#8b8d92",
    keywords: [
      "管理",
      "整理",
      "設定",
      "経理",
      "スケジュール",
      "運営",
      "事務",
      "会議",
      "operations",
      "organize",
      "schedule",
      "admin",
    ],
  },
  {
    id: "other",
    name: "フリースペース",
    en: "Flex space",
    color: "#899a9d",
    keywords: [],
  },
];

export function classifyTask(task, roles = DEFAULT_ROLES, overrides = {}) {
  const explicit = overrides[task.id] || task.roleHint;
  if (roles.some((role) => role.id === explicit))
    return { roleId: explicit, reason: "manual" };
  const title = String(task.title || "")
    .normalize("NFKC")
    .toLowerCase();
  const assignment = String(task.agentTask || "")
    .normalize("NFKC")
    .toLowerCase();
  const project = String(task.project || "")
    .normalize("NFKC")
    .toLowerCase();
  let best = null,
    score = 0;
  for (const role of roles) {
    let points = 0;
    for (const raw of role.keywords || []) {
      const key = String(raw).trim().normalize("NFKC").toLowerCase();
      if (!key) continue;
      // Short Latin words must be whole tokens: "ui" must not match "build".
      const has = (text) =>
        /^[a-z0-9 ]+$/.test(key)
          ? new RegExp(
              `(?:^|[^a-z0-9])${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`,
              "i",
            ).test(text)
          : text.includes(key);
      if (has(assignment)) points += 12;
      else if (has(title))
        points += ["修正", "設定", "構築", "管理", "検証"].includes(key)
          ? 1
          : 3;
      else if (has(project)) points += 1;
    }
    if (points > score) {
      score = points;
      best = role.id;
    }
  }
  return {
    roleId:
      best || (roles.some((r) => r.id === "other") ? "other" : roles[0]?.id),
    reason: best ? "keyword" : "unclassified",
  };
}

/** Several observed departments create several seats, never extra AI jobs. */
export function assignRoles(task, roles = DEFAULT_ROLES, overrides = {}) {
  if (overrides[task.id] && roles.some((r) => r.id === overrides[task.id]))
    return [{ roleId: overrides[task.id], reason: "manual" }];
  const observed = Array.isArray(task.activeRoles) ? task.activeRoles : [],
    unique = new Map();
  if (task.status === "working" || task.status === "waiting")
    for (const signal of observed) {
      if (signal && roles.some((r) => r.id === signal.roleId))
        unique.set(signal.roleId, {
          roleId: signal.roleId,
          reason: "activity",
          evidence: signal.evidence,
        });
    }
  return unique.size
    ? [...unique.values()]
    : [classifyTask(task, roles, overrides)];
}
